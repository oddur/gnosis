import { app, autoUpdater, BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import crypto from 'crypto';
import { Octokit } from '@octokit/rest';
import {
  parsePrUrl,
  getPrMetadata,
  getPrDiff,
  getChangedFiles,
  getFileContent,
  getFileMetadata,
  getNeighborFiles,
  getProjectClaudeContext,
  searchPullRequests,
  searchRepos,
  listRepoPullRequests,
  getCiStatus,
  getReviewStatus,
} from '../lib/github';
import type { CiCheck, FileMetadata, PrMetadata, PrSearchResult, PrStatus } from '../lib/types';
import { buildContextPackage, buildPlannerContext, buildTopicContext } from '../lib/context-builder';
import { generateReviewGuide, planReview, generateSlide } from '../lib/agent';
import { buildArchive, parseArchive } from '../lib/review-archive';
import { checkForUpdate } from '../lib/updater';
import { renderDiffHunk, reRenderAllHunks } from '../lib/highlight';
import { parseDiffLines, parsePatchValidLines } from '../lib/diff-lines';
import { setBinaryOverride, detectBinaryPath, resolveBinaryPath } from '../lib/providers/shared';
import { getProvider } from '../lib/provider';
import { buildSlideChatSystemPrompt, buildSlideChatUserMessage } from '../lib/chat-agent';
import { buildIndexedHunks, expandFullDiff, formatHunkIndexForPrompt, sortDiffHunks } from '../lib/diff-parse';
import { classifyFiles, filterDiff, buildExcludedFilesSummary } from '../lib/file-filter';
import { writeMcpConfig, cleanupMcpConfig } from '../lib/mcp-config';
import { initialize as initAptabase, trackEvent } from '@aptabase/electron/main';
import { createTray, updateTrayMenu, destroyTray, setStatusFetcher } from './tray';
import type {
  ChangedFile,
  DiffHunk,
  GenerateReviewRequest,
  ModelId,
  Preferences,
  ReviewGuide,
  ReviewHistoryEntry,
  Slide,
  SendSlideChatRequest,
  StartReviewResult,
  SubmitReviewRequest,
  FreshnessResult,
} from '../lib/types';

// Injected by Electron Forge Vite plugin
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

// Injected by Vite define
declare const __GH_CLIENT_SECRET__: string;

const GITHUB_CLIENT_ID = 'Ov23lifGr1yrXtcZD5Og';
const GITHUB_CLIENT_SECRET: string = typeof __GH_CLIENT_SECRET__ !== 'undefined' ? __GH_CLIENT_SECRET__ : '';

const APTABASE_APP_KEY = 'A-EU-7599830434';
let aptabaseInitialized = false;

function enableAnalyticsIfAllowed(prefs: Preferences): void {
  if (!prefs.analytics || aptabaseInitialized) return;
  void initAptabase(APTABASE_APP_KEY);
  aptabaseInitialized = true;
}

// ── In-memory cache ─────────────────────────────────────────────

let cachedToken: string | null = null;
let cachedLogin: string | null = null;

// ── Token storage helpers ────────────────────────────────────────

function getTokenPath() {
  return path.join(app.getPath('userData'), 'token.enc');
}

function getPlainTokenPath() {
  return getTokenPath() + '.plain';
}

function loadStoredToken(): string | null {
  // Avoid calling safeStorage.isEncryptionAvailable() — on macOS it can trigger its
  // own Keychain prompt before decryptString() does, causing two prompts on startup.
  // Instead, try decryptString() directly and fall back to plaintext on any error.
  try {
    if (fs.existsSync(getTokenPath())) {
      return safeStorage.decryptString(fs.readFileSync(getTokenPath()));
    }
  } catch {
    // Encryption unavailable or data corrupted — fall through to plaintext
  }
  try {
    if (fs.existsSync(getPlainTokenPath())) {
      return fs.readFileSync(getPlainTokenPath(), 'utf-8').trim();
    }
  } catch {
    // ignore
  }
  return null;
}

function persistToken(token: string) {
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(getTokenPath(), safeStorage.encryptString(token));
  } else {
    fs.writeFileSync(getPlainTokenPath(), token, { encoding: 'utf-8', mode: 0o600 });
  }
}

function deleteStoredToken() {
  const p = getTokenPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const plain = getPlainTokenPath();
  if (fs.existsSync(plain)) fs.unlinkSync(plain);
}

function getResolvedToken(): string | null {
  if (cachedToken) return cachedToken;
  const token = loadStoredToken();
  if (token) cachedToken = token; // cache so keychain is only unlocked once per session
  return token;
}

// ── OAuth flow ──────────────────────────────────────────────────

async function exchangeCodeForToken(code: string, codeVerifier: string, redirectUri: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    client_secret: GITHUB_CLIENT_SECRET,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });

  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!data.access_token) {
    throw new Error(data.error_description ?? data.error ?? 'OAuth token exchange failed');
  }
  return data.access_token;
}

async function fetchGitHubLogin(token: string): Promise<string> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `token ${token}`,
      'User-Agent': 'Gnosis-App',
    },
  });
  const data = (await res.json()) as { login?: string };
  return data.login ?? 'unknown';
}

async function validateAndFetchLogin(token: string): Promise<string> {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `token ${token}`, 'User-Agent': 'Gnosis-App' },
  });
  if (!res.ok) throw new Error(`Invalid token (GitHub returned ${res.status})`);
  const data = (await res.json()) as { login?: string };
  if (!data.login) throw new Error('Token validated but could not retrieve GitHub username');
  return data.login;
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function runOAuthFlow(): Promise<void> {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(20).toString('hex');
    const { verifier, challenge } = generatePkce();

    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- async HTTP handler
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const returnedState = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const errorParam = url.searchParams.get('error');

      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><p>Invalid state parameter. Please try again.</p></body></html>');
        server.close();
        reject(new Error('OAuth state mismatch'));
        return;
      }

      if (errorParam || !code) {
        const desc = url.searchParams.get('error_description') ?? errorParam ?? 'Unknown error';
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><p>Sign-in failed: ${desc}</p></body></html>`);
        server.close();
        reject(new Error(desc));
        return;
      }

      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const redirectUri = `http://127.0.0.1:${port}/callback`;

      try {
        const token = await exchangeCodeForToken(code, verifier, redirectUri);
        const login = await fetchGitHubLogin(token);
        persistToken(token);
        cachedToken = token;
        cachedLogin = login;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><p>You are now signed in to Gnosis. You can close this tab.</p></body></html>');
        server.close();
        resolve();
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<html><body><p>Authentication failed. Please try again.</p></body></html>');
        server.close();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Failed to start OAuth callback server'));
        return;
      }

      const port = addr.port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const params = new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: 'repo',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      void shell.openExternal(`https://github.com/login/oauth/authorize?${params}`);
    });

    const timeout = setTimeout(
      () => {
        server.close();
        reject(new Error('OAuth sign-in timed out after 5 minutes'));
      },
      5 * 60 * 1000
    );

    server.on('close', () => clearTimeout(timeout));
  });
}

// ── Persistent logging ───────────────────────────────────────────

function getLogsDir() {
  return path.join(app.getPath('userData'), 'logs');
}

function setupLogging() {
  const logsDir = getLogsDir();
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  const logPath = path.join(logsDir, 'main.log');
  const prevPath = path.join(logsDir, 'main.log.1');

  // Rotate previous log
  if (fs.existsSync(logPath)) {
    try {
      fs.renameSync(logPath, prevPath);
    } catch {
      // Best-effort rotation
    }
  }

  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  function write(level: string, args: unknown[]) {
    const ts = new Date().toISOString();
    const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    stream.write(`${ts} [${level}] ${msg}\n`);
  }

  console.log = (...args: unknown[]) => {
    origLog(...args);
    write('info', args);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    write('warn', args);
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    write('error', args);
  };
}

// ── Window ───────────────────────────────────────────────────────

let quitConfirmed = false;

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[main] Renderer failed to load:', errorCode, errorDescription);
  });

  // Open external links in the user's default browser instead of a new Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // On non-macOS, closing the window quits the app — confirm if a review is in progress.
  // On macOS, closing the window leaves the app running so reviews complete in the background.
  if (process.platform !== 'darwin') {
    mainWindow.on('close', (event) => {
      if (quitConfirmed || activeGenerations.size === 0) return;
      event.preventDefault();
      const count = activeGenerations.size;
      const response = dialog.showMessageBoxSync(mainWindow, {
        type: 'question',
        buttons: ['Cancel', 'Quit Anyway'],
        defaultId: 0,
        cancelId: 0,
        message: `Quit while ${count === 1 ? 'a review is' : `${count} reviews are`} generating?`,
        detail: `${count === 1 ? 'It' : 'They'} will be cancelled if you quit now.`,
      });
      if (response === 1) {
        quitConfirmed = true;
        mainWindow.destroy();
      }
    });
  }

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

// ── Update check helpers ─────────────────────────────────────

let dismissedUpdateVersion: string | null = null;

async function runUpdateCheck() {
  const update = await checkForUpdate(app.getVersion(), getResolvedToken() ?? undefined);
  if (!update) return;
  if (dismissedUpdateVersion === update.version) return;

  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send('update-available', update);
  }
}

let updateInterval: ReturnType<typeof setInterval> | null = null;

function startUpdateChecks() {
  setTimeout(() => void runUpdateCheck(), 5_000);
  updateInterval = setInterval(() => void runUpdateCheck(), 4 * 60 * 60 * 1_000);
}

// ── GitHub rate-limit handling ──────────────────────────────────

function isRateLimitError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('rate limit') || msg.includes('api rate limit');
  }
  return false;
}

/** Extract the reset time from a GitHub rate-limit error, or return a default backoff. */
function getRateLimitResetMs(err: unknown): number {
  // Octokit errors sometimes carry response headers
  const response = (err as Record<string, unknown>)?.response as Record<string, unknown> | undefined;
  const headers = response?.headers as Record<string, string> | undefined;
  const reset = headers?.['x-ratelimit-reset'];
  if (reset) {
    const resetMs = parseInt(reset, 10) * 1000 - Date.now();
    if (resetMs > 0) return Math.min(resetMs, 60 * 60 * 1000); // cap at 1 hour
  }
  return 5 * 60 * 1000; // default: 5 min backoff
}

/** Rethrow with a friendly message if the error is a rate limit. */
function friendlyRateLimitError(err: unknown): never {
  if (isRateLimitError(err)) {
    const waitMin = Math.ceil(getRateLimitResetMs(err) / 60_000);
    throw new Error(`GitHub API rate limit reached. Try again in ~${waitMin} minutes.`);
  }
  throw err;
}

// Timestamp when rate-limit backoff expires. Proactive polling skips work until this passes.
let rateLimitBackoffUntil = 0;

// ── Proactive mode ─────────────────────────────────────────────
//
// Periodically polls GitHub for PRs from three sources:
// 1. PRs authored by the user
// 2. PRs where the user is requested as reviewer
// 3. All open PRs in user-selected "watched repos"
//
// New PRs get a background review. Existing reviews whose PR head
// has changed get an automatic re-review (marked autoUpdated).

const PROACTIVE_POLL_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes
const PROACTIVE_MAX_AGE_MS = 24 * 60 * 60 * 1_000; // ignore PRs not updated within 24 h
const PROACTIVE_MAX_CONCURRENT_UPDATES = 2;

function getProactiveSeenPath() {
  return path.join(app.getPath('userData'), 'proactive-seen.json');
}

function loadProactiveSeen(): Set<string> {
  try {
    const data = JSON.parse(fs.readFileSync(getProactiveSeenPath(), 'utf-8')) as string[];
    return new Set(data);
  } catch {
    // Migrate from old file name if it exists
    try {
      const oldPath = path.join(app.getPath('userData'), 'seen-review-requests.json');
      const data = JSON.parse(fs.readFileSync(oldPath, 'utf-8')) as string[];
      return new Set(data);
    } catch {
      return new Set();
    }
  }
}

function saveProactiveSeen(seen: Set<string>) {
  fs.writeFileSync(getProactiveSeenPath(), JSON.stringify([...seen], null, 2));
}

let proactiveSeen = new Set<string>();

async function triggerProactiveReview(
  prUrl: string,
  prefs: Preferences,
  opts: { autoUpdated?: boolean; prData?: PrMetadata } = {}
): Promise<void> {
  console.log(`[proactive] Starting ${opts.autoUpdated ? 'update' : 'new'} review for ${prUrl}`);
  const reviewId = crypto.randomUUID();

  try {
    let prData = opts.prData;
    if (!prData) {
      const octokit = new Octokit({ auth: cachedToken ?? undefined });
      const { owner, repo, pullNumber } = parsePrUrl(prUrl);
      prData = await getPrMetadata(octokit, owner, repo, pullNumber);
    }

    // Cancel any in-flight generation for this PR
    cancelExistingGenerationForPr(prUrl);

    const useOverrides = prefs.proactiveReviewOverrides;
    const provider = useOverrides ? prefs.proactiveProvider : prefs.provider;
    const model = useOverrides ? prefs.proactiveModel : prefs.model;
    const thinking = useOverrides ? prefs.proactiveThinking : prefs.thinking;

    const abortController = new AbortController();
    createPendingHistoryEntry(reviewId, prData.title, prUrl, prData.author, model, 'open', prData.headSha, true);
    if (opts.autoUpdated) {
      updateHistoryEntry(reviewId, { autoUpdated: true });
    }
    activeGenerations.set(reviewId, { abortController, prUrl });

    const request: GenerateReviewRequest = {
      prUrl,
      provider,
      model,
      instructions: prefs.instructions,
      thinking,
      smartImports: prefs.smartImports,
      reviewSuggestions: prefs.reviewSuggestions,
      educationMode: prefs.educationMode,
      claudeContext: prefs.claudeContext,
    };

    await runBackgroundGeneration(reviewId, request, prData, abortController.signal);

    broadcastToAllWindows('new-review-in-history');
    console.log(`[proactive] Completed ${opts.autoUpdated ? 'update' : 'review'} for ${prUrl}`);
  } catch (err) {
    console.error(`[proactive] Failed for ${prUrl}:`, err);
  }
}

async function runProactiveCheck() {
  if (!cachedToken || !cachedLogin) return;
  if (Date.now() < rateLimitBackoffUntil) {
    console.log(`[proactive] Skipping — rate-limit backoff until ${new Date(rateLimitBackoffUntil).toLocaleTimeString()}`);
    return;
  }
  const prefs = loadPreferences();
  if (!prefs.proactiveMode) return;

  try {
    const octokit = new Octokit({ auth: cachedToken });

    // ── Phase 1: Discover PRs from all three sources ──

    // Source 1 & 2: my PRs + assigned PRs (already combined by searchPullRequests)
    const myPrs = await searchPullRequests(octokit, cachedLogin);

    // Source 3: watched repo PRs (fetched in parallel)
    // Clamp maxPrsPerRepo to GitHub's supported range (1-100) and default to 10 if invalid
    const maxPerRepo = Math.min(100, Math.max(1, Number.isFinite(prefs.maxPrsPerRepo) ? prefs.maxPrsPerRepo : 10));
    const watchedResults = await Promise.allSettled(
      prefs.watchedRepos.map(async (repoRef) => {
        const [owner, repo] = repoRef.split('/');
        if (!owner || !repo) return [];
        return listRepoPullRequests(octokit, owner, repo, maxPerRepo);
      })
    );
    const watchedPrs: PrSearchResult[] = [];
    for (const result of watchedResults) {
      if (result.status === 'fulfilled') watchedPrs.push(...result.value);
    }

    // Deduplicate: my PRs take priority over watched (more specific role)
    const allPrs = new Map<string, PrSearchResult>();
    for (const pr of watchedPrs) allPrs.set(pr.url, pr);
    for (const pr of myPrs) allPrs.set(pr.url, pr);

    // ── Phase 2: Review unseen PRs (capped to avoid flooding) ──

    const now = Date.now();
    let newCount = 0;
    for (const pr of allPrs.values()) {
      if (newCount >= PROACTIVE_MAX_CONCURRENT_UPDATES) break;
      if (pr.isDraft) continue;
      if (!proactiveSeen.has(pr.url)) {
        proactiveSeen.add(pr.url);

        const updatedAt = new Date(pr.updatedAt).getTime();
        if (now - updatedAt <= PROACTIVE_MAX_AGE_MS) {
          void triggerProactiveReview(pr.url, prefs);
          newCount++;
        } else {
          console.log(`[proactive] Skipping stale PR (${Math.round((now - updatedAt) / 3_600_000)}h old): ${pr.url}`);
        }
      }
    }
    // Prune: keep only URLs still in the current open-PR set
    for (const url of proactiveSeen) {
      if (!allPrs.has(url)) proactiveSeen.delete(url);
    }
    saveProactiveSeen(proactiveSeen);

    // ── Phase 3: Auto-update outdated existing reviews ──

    const index = readReviewsIndex();
    const openCompletedByPr = new Map<string, ReviewHistoryEntry>();
    for (const entry of index) {
      if (entry.status === 'completed' && entry.prState === 'open' && entry.prHeadSha) {
        // Keep only the latest review per PR URL
        const existing = openCompletedByPr.get(entry.prUrl);
        if (!existing || new Date(entry.savedAt) > new Date(existing.savedAt)) {
          openCompletedByPr.set(entry.prUrl, entry);
        }
      }
    }

    // Check if any currently-generating reviews exist for a PR to avoid double-generation
    const generatingPrUrls = new Set(
      index.filter((e) => e.status === 'generating').map((e) => e.prUrl)
    );

    let updateCount = 0;
    for (const [prUrl, entry] of openCompletedByPr) {
      if (updateCount >= PROACTIVE_MAX_CONCURRENT_UPDATES) break;
      if (generatingPrUrls.has(prUrl)) continue;

      try {
        const { owner, repo, pullNumber } = parsePrUrl(prUrl);
        const prData = await getPrMetadata(octokit, owner, repo, pullNumber);

        if (prData.headSha !== entry.prHeadSha) {
          console.log(`[proactive] PR head changed for ${prUrl} (${entry.prHeadSha?.slice(0, 7)} → ${prData.headSha.slice(0, 7)}), re-reviewing`);
          void triggerProactiveReview(prUrl, prefs, { autoUpdated: true, prData });
          updateCount++;
        }
      } catch (err) {
        console.warn(`[proactive] Failed to check freshness for ${prUrl}:`, err);
      }
    }
  } catch (err) {
    if (isRateLimitError(err)) {
      const backoffMs = getRateLimitResetMs(err);
      rateLimitBackoffUntil = Date.now() + backoffMs;
      console.warn(`[proactive] Rate-limited — backing off for ${Math.ceil(backoffMs / 60_000)} minutes`);
    } else {
      console.error('[proactive] Poll check failed:', err);
    }
  }
}

let proactiveInterval: ReturnType<typeof setInterval> | null = null;

function startProactivePolling() {
  if (proactiveInterval) return;
  proactiveSeen = loadProactiveSeen();
  setTimeout(() => void runProactiveCheck(), 10_000);
  proactiveInterval = setInterval(() => void runProactiveCheck(), PROACTIVE_POLL_INTERVAL_MS);
}

function stopProactivePolling() {
  if (proactiveInterval) {
    clearInterval(proactiveInterval);
    proactiveInterval = null;
  }
}

// ── Auto-updater (Squirrel) ─────────────────────────────────────
function setupAutoUpdater() {
  if (!app.isPackaged) return;
  if (process.platform === 'linux') return;

  const feedURL = `https://update.electronjs.org/oddur/gnosis/${process.platform}-${process.arch}/${app.getVersion()}`;
  try {
    autoUpdater.setFeedURL({ url: feedURL });
  } catch (err) {
    console.warn('[main] Failed to set autoUpdater feed URL:', err);
    return;
  }

  autoUpdater.on('update-downloaded', (_event, _releaseNotes, releaseName) => {
    const version = releaseName.replace(/^v/, '');
    const label = version ? ` ${version}` : '';
    console.log(`[main] Update${label} downloaded, will install on exit`);
    if (loadPreferences().notifications) {
      const notif = new Notification({
        title: 'A new update is ready to install',
        body: `Gnosis${label} has been downloaded and will be automatically installed on exit`,
        silent: true,
      });
      notif.show();
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('update-ready', version);
    }
  });

  autoUpdater.on('error', (err: Error) => {
    console.warn('[main] Auto-updater error:', err.message);
  });

  // Check for updates automatically — download happens silently
  autoUpdater.checkForUpdates();
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1_000);
}

void app.whenReady().then(() => {
  setupLogging();

  // Expose packaged state to preload via env var (before creating windows)
  process.env.APP_IS_PACKAGED = app.isPackaged ? '1' : '0';

  const prefs = loadPreferences();
  enableAnalyticsIfAllowed(prefs);
  if (prefs.analytics) void trackEvent('app_started');

  // Mark any stale "generating" entries from a previous crash as failed
  cleanupStaleGeneratingEntries();
  // Backfill summaries for reviews that predate the summary field
  backfillSummaries();
  applyBinaryOverrides(loadPreferences());
  createWindow();
  initTrayIfEnabled();
  setStatusFetcher(fetchPrStatus);
  rebuildTrayMenu();
  setupAutoUpdater();

  // GitHub release polling only needed on Linux (no native auto-update)
  if (process.platform === 'linux') {
    startUpdateChecks();
  }

  if (loadPreferences().proactiveMode) startProactivePolling();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    if (!updateInterval && process.platform === 'linux') startUpdateChecks();
    if (!proactiveInterval && loadPreferences().proactiveMode) startProactivePolling();
  });
});

app.on('before-quit', (event) => {
  if (!quitConfirmed && activeGenerations.size > 0) {
    event.preventDefault();
    const count = activeGenerations.size;
    const win = BrowserWindow.getAllWindows()[0];
    const response = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Cancel', 'Quit Anyway'],
      defaultId: 0,
      cancelId: 0,
      message: `Quit while ${count === 1 ? 'a review is' : `${count} reviews are`} generating?`,
      detail: `${count === 1 ? 'It' : 'They'} will be cancelled if you quit now.`,
    });
    if (response === 1) {
      quitConfirmed = true;
      app.quit();
    }
    return;
  }
  // Mark any in-flight generations as failed
  for (const [id] of activeGenerations) {
    updateHistoryEntry(id, { status: 'failed', error: 'App quit during generation' });
  }
  activeGenerations.clear();
  destroyTray();
});

app.on('window-all-closed', () => {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
  stopProactivePolling();
  if (process.platform !== 'darwin') app.quit();
});

// ── Review history helpers ───────────────────────────────────────

function getReviewsDir() {
  return path.join(app.getPath('userData'), 'reviews');
}

function getReviewsIndexPath() {
  return path.join(app.getPath('userData'), 'reviews-index.json');
}

function ensureReviewsDir() {
  const dir = getReviewsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function suggestArchiveName(entry: ReviewHistoryEntry): string {
  // Lifted from the PR URL when possible so the default file name
  // reads as e.g. "owner-repo-pr-123.gr"; falls back to the title.
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(entry.prUrl);
  const base = m
    ? `${m[1]}-${m[2]}-pr-${m[3]}`
    : entry.prTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'review';
  return `${base}.gr`;
}

function readReviewsIndex(): ReviewHistoryEntry[] {
  try {
    const entries = JSON.parse(fs.readFileSync(getReviewsIndexPath(), 'utf-8')) as ReviewHistoryEntry[];
    // Backward compat: entries without status are completed
    return entries.map((e) => ({ ...e, status: e.status ?? 'completed' }));
  } catch {
    return [];
  }
}

/** One-time migration: backfill summary from full review JSON into
 *  the index for entries that predate the summary field. Runs once
 *  at startup and persists results so subsequent reads are fast. */
function backfillSummaries(): void {
  const index = readReviewsIndex();
  let dirty = false;
  for (const entry of index) {
    if (!entry.summary && entry.status === 'completed') {
      try {
        const reviewPath = path.join(getReviewsDir(), `${entry.id}.json`);
        const review = JSON.parse(fs.readFileSync(reviewPath, 'utf-8')) as ReviewGuide;
        if (review.summary) {
          entry.summary = review.summary;
          dirty = true;
        }
      } catch {
        // Review file missing or unreadable — skip
      }
    }
  }
  if (dirty) {
    fs.writeFileSync(getReviewsIndexPath(), JSON.stringify(index, null, 2));
  }
}

// ── Background generation tracking ──────────────────────────────

const activeGenerations = new Map<string, { abortController?: AbortController; prUrl?: string }>();

/** Cancel any in-flight generation for the same PR URL. */
function cancelExistingGenerationForPr(prUrl: string): void {
  for (const [id, gen] of activeGenerations) {
    if (gen.prUrl === prUrl) {
      console.log(`[main] Cancelling stale generation ${id} for ${prUrl}`);
      gen.abortController?.abort('Superseded by new review');
      updateHistoryEntry(id, { status: 'failed', error: 'Superseded by newer review' });
      activeGenerations.delete(id);
    }
  }
}

function createPendingHistoryEntry(
  id: string,
  prTitle: string,
  prUrl: string,
  author: string,
  model?: ModelId,
  prState?: 'open' | 'merged' | 'closed',
  prHeadSha?: string,
  unread?: boolean
): void {
  ensureReviewsDir();
  const entry: ReviewHistoryEntry = {
    id,
    prTitle,
    prUrl,
    author,
    riskLevel: 'low', // placeholder until generation completes
    status: 'generating',
    model,
    savedAt: new Date().toISOString(),
    prState,
    prHeadSha,
    ...(unread ? { unread: true } : {}),
  };
  const index = readReviewsIndex();
  index.unshift(entry);
  fs.writeFileSync(getReviewsIndexPath(), JSON.stringify(index, null, 2));
  rebuildTrayMenu();
}

function updateHistoryEntry(id: string, updates: Partial<ReviewHistoryEntry>): void {
  const index = readReviewsIndex();
  const idx = index.findIndex((e) => e.id === id);
  if (idx === -1) return;
  index[idx] = { ...index[idx], ...updates };
  fs.writeFileSync(getReviewsIndexPath(), JSON.stringify(index, null, 2));
  rebuildTrayMenu();
}

function broadcastToAllWindows(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args);
  }
}

function showOrCreateWindow(): void {
  const windows = BrowserWindow.getAllWindows();
  if (windows.length > 0) {
    const win = windows[0];
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else {
    createWindow();
  }
}

function navigateToReview(reviewId: string): void {
  showOrCreateWindow();
  setTimeout(() => broadcastToAllWindows('review-navigate', { reviewId }), 100);
}

function initTrayIfEnabled(): void {
  // Read raw prefs once to check if trayEnabled has ever been set
  let raw: Record<string, unknown> | null = null;
  try {
    raw = JSON.parse(fs.readFileSync(getPreferencesPath(), 'utf-8')) as Record<string, unknown>;
  } catch { /* first run, no prefs file */ }

  if (!raw || !('trayEnabled' in raw)) {
    // First time — ask via in-app modal once the renderer is ready
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('show-tray-prompt');
      });
    }
  } else if (raw.trayEnabled) {
    createTray();
    rebuildTrayMenu();
  }
}

function rebuildTrayMenu(): void {
  updateTrayMenu(readReviewsIndex(), {
    onShowWindow: showOrCreateWindow,
    onNavigateToReview: navigateToReview,
    onOpenExternal: (url: string) => {
      try { if (new URL(url).protocol === 'https:') void shell.openExternal(url); } catch {}
    },
    onQuit: () => app.quit(),
  });
}

function cleanupStaleGeneratingEntries(): void {
  const index = readReviewsIndex();
  let changed = false;
  for (const entry of index) {
    if (entry.status === 'generating') {
      entry.status = 'failed';
      entry.error = 'Generation was interrupted';
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(getReviewsIndexPath(), JSON.stringify(index, null, 2));
  }
}

// ── Preferences helpers ─────────────────────────────────────────

function getPreferencesPath() {
  return path.join(app.getPath('userData'), 'preferences.json');
}

const DEFAULT_PREFERENCES: Preferences = {
  instructions: '',
  provider: 'claude',
  model: 'claude-opus-4-7',
  thinking: true,
  smartImports: true,
  reviewSuggestions: true,
  enableTools: false,
  enableWebResearch: false,
  proactiveMode: false,
  watchedRepos: [],
  codeTheme: 'aurora-x',
  codeFont: 'jetbrains-mono',
  claudePath: '',
  geminiPath: '',
  notifications: true,
  diffLayout: 'unified',
  includeAllFiles: true,
  reviewSignature: true,
  firstRunSeen: false,
  theme: 'system',
  trayEnabled: true,
  maxPrsPerRepo: 10,
  parallelReview: true,
  analytics: true,
  proactiveReviewOverrides: false,
  proactiveProvider: 'claude',
  proactiveModel: 'claude-sonnet-4-6',
  proactiveThinking: false,
  educationMode: true,
  claudeContext: true,
};

function applyBinaryOverrides(prefs: Preferences): void {
  setBinaryOverride('claude', prefs.claudePath);
  setBinaryOverride('gemini', prefs.geminiPath);
}

function loadPreferences(): Preferences {
  try {
    const stored = JSON.parse(fs.readFileSync(getPreferencesPath(), 'utf-8')) as Record<string, unknown>;
    // Backward compat: rename autoReviewOnRequest → proactiveMode
    if ('autoReviewOnRequest' in stored && !('proactiveMode' in stored)) {
      stored.proactiveMode = stored.autoReviewOnRequest;
      delete stored.autoReviewOnRequest;
    }
    if (stored.model === 'claude-opus-4-6') stored.model = 'claude-opus-4-7';
    return { ...DEFAULT_PREFERENCES, ...(stored as Partial<Preferences>) };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function savePreferences(prefs: Preferences): void {
  fs.writeFileSync(getPreferencesPath(), JSON.stringify(prefs, null, 2));
}

// ── MCP tools constants ─────────────────────────────────────────

const ALLOWED_TOOLS = [
  'WebFetch',
  'WebSearch',
  'mcp__github__get_file_contents',
  'mcp__github__get_issue',
  'mcp__github__list_issues',
  'mcp__github__get_pull_request',
  'mcp__github__get_pull_request_files',
  'mcp__github__get_pull_request_comments',
  'mcp__github__get_pull_request_reviews',
  'mcp__github__list_commits',
  'mcp__github__search_code',
  'mcp__github__search_issues',
];

const WEB_ONLY_TOOLS = ['WebFetch', 'WebSearch'];

// ── IPC handlers ────────────────────────────────────────────────

ipcMain.handle('dismiss-update', (_event, version: string) => {
  dismissedUpdateVersion = version;
});

ipcMain.handle('open-external', (_event, url: string) => {
  try {
    if (new URL(url).protocol === 'https:') {
      void shell.openExternal(url);
    }
  } catch {
    // invalid URL — ignore
  }
});

ipcMain.handle('open-logs-directory', () => {
  const logsDir = getLogsDir();
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  void shell.openPath(logsDir);
});

ipcMain.handle('open-review-prompt', (_event, id: string) => {
  const promptPath = path.join(getReviewsDir(), `${id}-prompt.md`);
  if (fs.existsSync(promptPath)) {
    void shell.openPath(promptPath);
  }
});

// Backward-compat shim — renderer still calls getConfig to check if signed in
ipcMain.handle('get-config', () => {
  const token = getResolvedToken();
  return { githubToken: token };
});

ipcMain.handle('start-oauth', async () => {
  await runOAuthFlow();
});

ipcMain.handle('save-pat', async (_event, token: string) => {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('Token must not be empty');
  const login = await validateAndFetchLogin(trimmed);
  persistToken(trimmed);
  cachedToken = trimmed;
  cachedLogin = login;
  return login;
});

ipcMain.handle('get-auth-state', async () => {
  const token = getResolvedToken();
  if (!token) return { authenticated: false, login: null };

  if (!cachedLogin) {
    try {
      cachedLogin = await fetchGitHubLogin(token);
    } catch {
      // token may be invalid
      return { authenticated: false, login: null };
    }
  }

  return { authenticated: true, login: cachedLogin };
});

ipcMain.handle('sign-out', () => {
  cachedToken = null;
  cachedLogin = null;
  deleteStoredToken();
});

ipcMain.handle('search-pull-requests', async () => {
  const token = getResolvedToken();
  if (!token || !cachedLogin) throw new Error('Not authenticated');
  try {
    const octokit = new Octokit({ auth: token });
    return await searchPullRequests(octokit, cachedLogin);
  } catch (err) {
    friendlyRateLimitError(err);
  }
});

ipcMain.handle('search-repos', async (_event, query: string) => {
  const token = getResolvedToken();
  if (!token) throw new Error('Not authenticated');
  try {
    const octokit = new Octokit({ auth: token });
    return await searchRepos(octokit, query);
  } catch (err) {
    if (isRateLimitError(err)) return []; // silently return empty for autocomplete
    throw err;
  }
});

ipcMain.handle('load-preferences', () => {
  return loadPreferences();
});

ipcMain.handle('save-preferences', (_event, prefs: Preferences) => {
  savePreferences(prefs);
  applyBinaryOverrides(prefs);
  // Restart polling so the new proactiveMode value takes effect immediately
  stopProactivePolling();
  if (prefs.proactiveMode) startProactivePolling();
  // Toggle tray on/off
  if (prefs.trayEnabled) {
    createTray();
    rebuildTrayMenu();
  } else {
    destroyTray();
  }
  // Pick up analytics opt-in turned on mid-session. Opt-out takes effect on
  // next launch — the SDK has no deinit, so we just stop sending events.
  enableAnalyticsIfAllowed(prefs);
});

ipcMain.handle('detect-binary-path', (_event, name: string) => {
  const extra = name === 'claude' ? [`${os.homedir()}/.volta/bin/claude`, `${os.homedir()}/.local/bin/claude`] : [];
  return detectBinaryPath(name, extra);
});

ipcMain.handle('check-cli-installed', (_event, provider: string) => {
  const extra = provider === 'claude' ? [`${os.homedir()}/.volta/bin/claude`, `${os.homedir()}/.local/bin/claude`] : [];
  const resolved = resolveBinaryPath(provider, extra);
  const installed = path.isAbsolute(resolved) && fs.existsSync(resolved);
  return { installed, resolvedPath: resolved };
});

ipcMain.handle('list-reviews', () => {
  return readReviewsIndex();
});

ipcMain.handle('load-review', async (_event, id: string) => {
  const reviewPath = path.join(getReviewsDir(), `${id}.json`);
  const review = JSON.parse(fs.readFileSync(reviewPath, 'utf-8')) as ReviewGuide;
  const prefs = loadPreferences();
  await reRenderAllHunks(review, prefs.codeTheme);
  return review;
});

ipcMain.handle('re-render-hunks', async (_event, review: ReviewGuide) => {
  const prefs = loadPreferences();
  await reRenderAllHunks(review, prefs.codeTheme);
  return review;
});

ipcMain.handle('mark-review-read', (_event, id: string) => {
  const index = readReviewsIndex().map((e) =>
    e.id === id ? { ...e, unread: false, autoUpdated: false } : e
  );
  fs.writeFileSync(getReviewsIndexPath(), JSON.stringify(index, null, 2));
  rebuildTrayMenu();
});

ipcMain.handle('delete-review', (_event, id: string) => {
  const reviewPath = path.join(getReviewsDir(), `${id}.json`);
  const promptPath = path.join(getReviewsDir(), `${id}-prompt.md`);
  if (fs.existsSync(reviewPath)) fs.unlinkSync(reviewPath);
  if (fs.existsSync(promptPath)) fs.unlinkSync(promptPath);
  const index = readReviewsIndex().filter((e) => e.id !== id);
  fs.writeFileSync(getReviewsIndexPath(), JSON.stringify(index, null, 2));
  rebuildTrayMenu();
});

ipcMain.handle('export-review', async (event, id: string): Promise<string | null> => {
  const index = readReviewsIndex();
  const entry = index.find((e) => e.id === id);
  if (!entry) throw new Error(`Review ${id} not found.`);

  const reviewPath = path.join(getReviewsDir(), `${id}.json`);
  const promptPath = path.join(getReviewsDir(), `${id}-prompt.md`);
  const review = JSON.parse(fs.readFileSync(reviewPath, 'utf-8')) as ReviewGuide;
  const prompt = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf-8') : undefined;

  const win = BrowserWindow.fromWebContents(event.sender);
  const defaultName = suggestArchiveName(entry);
  const saveOpts = {
    title: 'Export review',
    defaultPath: defaultName,
    filters: [{ name: 'Gnosis Review', extensions: ['gr'] }],
  };
  const chosen = win ? await dialog.showSaveDialog(win, saveOpts) : await dialog.showSaveDialog(saveOpts);
  if (chosen.canceled || !chosen.filePath) return null;

  const buffer = buildArchive({ review, history: entry, prompt, appVersion: app.getVersion() });
  fs.writeFileSync(chosen.filePath, buffer);
  return chosen.filePath;
});

ipcMain.handle('import-review', async (event): Promise<ReviewHistoryEntry | null> => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const openOpts = {
    title: 'Import review',
    properties: ['openFile'] satisfies Array<'openFile'>,
    filters: [{ name: 'Gnosis Review', extensions: ['gr'] }],
  };
  const chosen = win ? await dialog.showOpenDialog(win, openOpts) : await dialog.showOpenDialog(openOpts);
  if (chosen.canceled || chosen.filePaths.length === 0) return null;

  const buffer = fs.readFileSync(chosen.filePaths[0]);
  const parsed = parseArchive(buffer);

  ensureReviewsDir();
  const newId = crypto.randomUUID();
  fs.writeFileSync(
    path.join(getReviewsDir(), `${newId}.json`),
    JSON.stringify(parsed.review, null, 2)
  );
  if (parsed.prompt) {
    fs.writeFileSync(path.join(getReviewsDir(), `${newId}-prompt.md`), parsed.prompt);
  }

  const entry: ReviewHistoryEntry = {
    ...parsed.metadata.history,
    id: newId,
    imported: true,
    status: 'completed',
  };
  const index = readReviewsIndex();
  index.unshift(entry);
  fs.writeFileSync(getReviewsIndexPath(), JSON.stringify(index, null, 2));
  rebuildTrayMenu();
  broadcastToAllWindows('new-review-in-history');
  return entry;
});

ipcMain.handle('delete-all-reviews', () => {
  const dir = getReviewsDir();
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('.json') || file.endsWith('-prompt.md')) fs.unlinkSync(path.join(dir, file));
    }
  }
  fs.writeFileSync(getReviewsIndexPath(), JSON.stringify([], null, 2));
  rebuildTrayMenu();
});

ipcMain.handle(
  'check-pr-freshness',
  async (_event, prUrl: string, headSha: string | undefined): Promise<FreshnessResult> => {
    if (!headSha) {
      return { status: 'unknown', reason: 'Review has no stored head SHA' };
    }

    const token = getResolvedToken();
    if (!token) return { status: 'unknown', reason: 'Not signed in' };
    const octokit = new Octokit({ auth: token });
    const { owner, repo, pullNumber } = parsePrUrl(prUrl);

    try {
      const prData = await getPrMetadata(octokit, owner, repo, pullNumber);
      const currentSha = prData.headSha;

      if (currentSha === headSha) {
        return { status: 'current' };
      }

      try {
        const { data } = await octokit.repos.compareCommits({
          owner,
          repo,
          base: headSha,
          head: currentSha,
        });

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- GitHub API defensive
        const commits = (data.commits ?? []).slice(0, 50).map((c) => ({
          sha: c.sha,
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- GitHub API defensive
          message: (c.commit.message ?? '').split('\n')[0],
          authorLogin: c.author?.login ?? c.commit.author?.name ?? 'unknown',
          authorDate: c.commit.author?.date ?? '',
        }));

        return {
          status: 'stale',
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- GitHub API defensive
          aheadBy: data.ahead_by ?? commits.length,
          commits,
        };
      } catch (compareErr: unknown) {
        const status = (compareErr as { status?: number }).status;
        if (status === 404) {
          return { status: 'force-pushed' };
        }
        throw compareErr;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { status: 'unknown', reason: message };
    }
  }
);

async function fetchPrStatus(prUrl: string): Promise<PrStatus | null> {
  const token = getResolvedToken();
  if (!token) return null;
  const octokit = new Octokit({ auth: token });
  const { owner, repo, pullNumber } = parsePrUrl(prUrl);

  const [prData, reviewSummary] = await Promise.all([
    getPrMetadata(octokit, owner, repo, pullNumber),
    getReviewStatus(octokit, owner, repo, pullNumber),
  ]);

  const ciStatus = await getCiStatus(octokit, owner, repo, prData.headSha).catch(() => ({
    checks: [] as CiCheck[],
    conclusion: 'neutral' as const,
  }));

  return {
    labels: prData.labels,
    mergeable: prData.mergeable,
    isDraft: prData.isDraft,
    ciChecks: ciStatus.checks,
    ciConclusion: ciStatus.conclusion,
    reviewSummary,
    baseBranch: prData.baseBranch,
    commitCount: prData.commitCount,
    requestedReviewers: prData.requestedReviewers,
    requestedTeams: prData.requestedTeams,
    mergeableState: prData.mergeableState,
    autoMerge: prData.autoMerge,
    milestone: prData.milestone,
  };
}

ipcMain.handle('get-pr-status', async (_event, prUrl: string): Promise<PrStatus> => {
  const status = await fetchPrStatus(prUrl);
  if (!status) throw new Error('Not authenticated');
  return status;
});

ipcMain.handle(
  'get-pr-state',
  async (_event, prUrl: string): Promise<{ prState: 'open' | 'merged' | 'closed'; headSha: string }> => {
    try {
      const token = getResolvedToken();
      const octokit = new Octokit({ auth: token ?? undefined });
      const { owner, repo, pullNumber } = parsePrUrl(prUrl);
      const prData = await getPrMetadata(octokit, owner, repo, pullNumber);
      const prState = prData.merged ? 'merged' : prData.state === 'open' ? 'open' : 'closed';
      return { prState, headSha: prData.headSha };
    } catch (err) {
      friendlyRateLimitError(err);
    }
  }
);

ipcMain.handle('get-pr-files', async (_event, prUrl: string): Promise<ChangedFile[]> => {
  const token = getResolvedToken();
  const octokit = new Octokit({ auth: token ?? undefined });
  const { owner, repo, pullNumber } = parsePrUrl(prUrl);
  return getChangedFiles(octokit, owner, repo, pullNumber);
});

// ── Background review generation ────────────────────────────────

/** Resolve hunk IDs to DiffHunk objects, skipping already-assigned ones. */
function resolveDiffHunks(
  ids: string[],
  hunkMap: Map<string, import('../lib/diff-parse').IndexedHunk>,
  assignedIds: Set<string>,
): DiffHunk[] {
  return ids
    .filter((id) => hunkMap.has(id) && !assignedIds.has(id))
    .map((id) => {
      assignedIds.add(id);
      const h = hunkMap.get(id)!;
      return {
        filePath: h.filePath,
        hunkHeader: h.expandedHunkHeader,
        content: h.expandedContent,
        language: h.language,
        renderedHtml: '',
      };
    });
}

async function runBackgroundGeneration(
  reviewId: string,
  request: GenerateReviewRequest,
  prData: Awaited<ReturnType<typeof getPrMetadata>>,
  signal: AbortSignal
): Promise<void> {
  const {
    prUrl,
    provider,
    model,
    instructions,
    thinking,
    smartImports,
    reviewSuggestions,
    webResearch,
    educationMode,
    claudeContext,
  } = request;

  try {
    const token = getResolvedToken();
    const octokit = new Octokit({ auth: token ?? undefined });
    const { owner, repo, pullNumber } = parsePrUrl(prUrl);

    broadcastToAllWindows('review-phase', { reviewId, phase: 'Fetching PR data' });

    // Fetch changed files first so we can pass them to getPrDiff as fallback
    const allChangedFiles = await getChangedFiles(octokit, owner, repo, pullNumber);
    const diff = await getPrDiff(octokit, owner, repo, pullNumber, allChangedFiles);

    // Fetch file metadata (age + churn) in the background while the
    // rest of the pipeline proceeds. We don't await it here — it
    // joins later when we assemble the ReviewGuide. This avoids
    // blocking the critical path (diff fetching, AI generation).
    const fileMetadataPromise: Promise<FileMetadata[]> = getFileMetadata(
      octokit, owner, repo, pullNumber, prData.baseSha, allChangedFiles
    ).catch((err: unknown) => {
      console.warn('[main] File metadata fetch failed, proceeding without:', err);
      return allChangedFiles.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      }));
    });

    // Apply user exclusions before any other processing
    const userExcludedSet = new Set(request.excludedFiles ?? []);
    const changedFiles =
      userExcludedSet.size > 0 ? allChangedFiles.filter((f) => !userExcludedSet.has(f.filename)) : allChangedFiles;
    const userFilteredDiff = userExcludedSet.size > 0 ? filterDiff(diff, userExcludedSet) : diff;

    if (changedFiles.length === 0) {
      throw new Error('PR has no changed files');
    }

    // Filter out generated/lock files early to avoid token budget blowup
    const { normalFiles, generatedFiles } = classifyFiles(changedFiles);
    const generatedFilenames = new Set(generatedFiles.map((f) => f.filename));
    const filteredDiff = filterDiff(userFilteredDiff, generatedFilenames);
    const excludedFilesSummary = buildExcludedFilesSummary(generatedFiles);

    if (generatedFiles.length > 0) {
      console.log(
        `[main] Filtered ${generatedFiles.length} generated file(s):`,
        generatedFiles.map((f) => f.filename)
      );
    }

    const baseRef = prData.baseBranch;
    const headRef = prData.headSha;

    broadcastToAllWindows('review-phase', { reviewId, phase: 'Fetching file contents' });

    const fileContents: Record<string, string> = {};
    const headFileContents: Record<string, string> = {};
    const concurrency = 5;
    const filesToFetch = normalFiles.filter((f) => f.status !== 'deleted');
    const filesToFetchBase = normalFiles.filter((f) => f.status !== 'added');

    for (let i = 0; i < Math.max(filesToFetch.length, filesToFetchBase.length); i += concurrency) {
      const headBatch = filesToFetch.slice(i, i + concurrency);
      const baseBatch = filesToFetchBase.slice(i, i + concurrency);
      await Promise.all([
        ...headBatch.map(async (f) => {
          const content = await getFileContent(octokit, owner, repo, f.filename, headRef);
          if (content !== null) headFileContents[f.filename] = content;
        }),
        ...baseBatch.map(async (f) => {
          const content = await getFileContent(octokit, owner, repo, f.filename, baseRef);
          if (content !== null) fileContents[f.filename] = content;
        }),
      ]);
    }

    broadcastToAllWindows('review-phase', { reviewId, phase: 'Resolving imports' });

    const allFileContents = { ...fileContents, ...headFileContents };
    // Fire the Claude-context probe in parallel with the neighbour
    // fetch — it hits `.claude/` and `CLAUDE.md` at head, which is
    // independent of the import graph we're walking in neighbours.
    const [neighborFiles, projectClaudeContext] = await Promise.all([
      getNeighborFiles(
        octokit,
        owner,
        repo,
        normalFiles.map((f) => f.filename),
        allFileContents,
        baseRef,
        smartImports ? provider : undefined
      ),
      claudeContext ? getProjectClaudeContext(octokit, owner, repo, headRef) : Promise.resolve(null),
    ]);
    if (projectClaudeContext) {
      const { commands, agents, skills, projectInstructionsBytes } = projectClaudeContext;
      console.log(
        `[claude-context] CLAUDE.md=${projectInstructionsBytes ?? 0}B, commands=${commands.length}, agents=${agents.length}, skills=${skills.length}`
      );
    }

    broadcastToAllWindows('review-phase', { reviewId, phase: 'Building context' });

    const prefs = loadPreferences();

    // Parse diff into indexed hunks — always needed
    const indexedHunks = buildIndexedHunks(filteredDiff, fileContents, headFileContents);
    const hunkIndex = formatHunkIndexForPrompt(indexedHunks);

    // Full context package only needed for single-shot mode
    let contextPackage = '';
    if (!prefs.parallelReview) {
      const expandedDiff = expandFullDiff(filteredDiff, fileContents, headFileContents);
      contextPackage = buildContextPackage(
        prData,
        expandedDiff,
        changedFiles,
        fileContents,
        headFileContents,
        neighborFiles,
        hunkIndex,
        excludedFilesSummary,
        projectClaudeContext
      );
    }

    console.log(`[main] Generating review guide (${reviewId})...`);
    const generationStart = Date.now();

    let resolvedSlides: Slide[];
    let aiResult: Awaited<ReturnType<typeof generateReviewGuide>> | null = null;
    let plan: Awaited<ReturnType<typeof planReview>> | null = null;

    const hunkMap = new Map(indexedHunks.map((h) => [h.id, h]));
    const assignedIds = new Set<string>();

    if (prefs.parallelReview) {
      // ── Two-phase: planner → parallel writers ──
      broadcastToAllWindows('review-phase', { reviewId, phase: 'Planning review structure' });

      const plannerContext = buildPlannerContext(prData, changedFiles, hunkIndex, excludedFilesSummary, projectClaudeContext);
      plan = await planReview(
        hunkIndex,
        plannerContext,
        provider,
        model,
        (chunk, isThinking) => broadcastToAllWindows('review-progress', { reviewId, chunk, isThinking }),
        thinking ?? false,
        signal,
      );

      console.log(`[main] Planner produced ${plan.topics.length} topics`);

      // Sort topics by planner's order
      const sortedTopics = [...plan.topics].sort((a, b) => a.order - b.order);
      const storyArc = plan.storyArc;

      // Fire all writers in parallel — the CLI/API handles its own rate limiting
      const slideResults: Slide[] = await Promise.all(
        sortedTopics.map(async (topic, idx) => {
            const slideNum = idx + 1;
            broadcastToAllWindows('review-phase', {
              reviewId,
              phase: `Writing slide ${slideNum}/${sortedTopics.length}: ${topic.title}`,
            });

            const topicCtx = buildTopicContext(
              topic, hunkMap, fileContents, headFileContents, neighborFiles,
              prData.title, prData.description, storyArc, sortedTopics,
              projectClaudeContext,
            );

            const writerOutput = await generateSlide({
              topicContext: topicCtx,
              providerName: provider,
              model,
              instructions,
              reviewSuggestions,
              thinking,
              educationMode,
              hasClaudeContext: !!projectClaudeContext,
              onChunk: (chunk, isThinking) =>
                broadcastToAllWindows('review-progress', { reviewId, chunk, isThinking }),
              signal,
            });

            const diffHunks = resolveDiffHunks(topic.hunkIds ?? [], hunkMap, assignedIds);

            return {
              id: `slide-${slideNum}`,
              slideNumber: slideNum,
              title: topic.title,
              slideType: topic.slideType,
              narrative: writerOutput.narrative,
              reviewFocus: writerOutput.reviewFocus,
              diffHunks: sortDiffHunks(diffHunks),
              contextSnippets: writerOutput.contextSnippets ?? [],
              affectedFiles: [...new Set(diffHunks.map((h) => h.filePath))],
              dependsOn: topic.dependsOn,
              mermaidDiagram: writerOutput.mermaidDiagram,
              reviewChecks: writerOutput.reviewChecks,
              educationNotes: writerOutput.educationNotes,
              importance: topic.importance,
            } satisfies Slide;
        })
      );

      resolvedSlides = slideResults;
    } else {
      // ── Single-shot: existing approach ──
      broadcastToAllWindows('review-phase', { reviewId, phase: 'Generating review' });

      let mcpConfigPath: string | undefined;
      let allowedTools: string[] | undefined;
      if (prefs.enableTools && provider === 'claude') {
        if (token) {
          mcpConfigPath = writeMcpConfig(token);
          allowedTools = ALLOWED_TOOLS;
        } else {
          allowedTools = WEB_ONLY_TOOLS;
        }
      } else if (webResearch && provider === 'claude') {
        allowedTools = WEB_ONLY_TOOLS;
      }

      let lastStreamPhase: string | null = null;
      try {
        aiResult = await generateReviewGuide({
          contextPackage,
          prUrl,
          providerName: provider,
          model,
          instructions,
          thinking,
          reviewSuggestions,
          webResearch,
          educationMode,
          hasClaudeContext: !!projectClaudeContext,
          mcpConfigPath,
          allowedTools,
          onChunk: (chunk, isThinking) => {
            const phase = isThinking ? 'Thinking' : 'Generating review';
            if (phase !== lastStreamPhase) {
              lastStreamPhase = phase;
              broadcastToAllWindows('review-phase', { reviewId, phase });
            }
            broadcastToAllWindows('review-progress', { reviewId, chunk, isThinking });
          },
          onToolUse: (toolName) => broadcastToAllWindows('review-tool-use', { reviewId, toolName }),
          onPromptReady: (system, userMessage) => {
            broadcastToAllWindows('review-stats', {
              reviewId,
              inputBytes: system.length + userMessage.length,
            });
            try {
              ensureReviewsDir();
              fs.writeFileSync(
                path.join(getReviewsDir(), `${reviewId}-prompt.md`),
                `# System Prompt\n\n${system}\n\n# User Message\n\n${userMessage}\n`
              );
            } catch {
              // Best-effort
            }
          },
          signal,
        });
      } finally {
        if (mcpConfigPath) cleanupMcpConfig(mcpConfigPath);
      }

      resolvedSlides = aiResult.slides.map((aiSlide) => {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- AI response may omit fields
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- AI response may omit fields
        const diffHunks = resolveDiffHunks(aiSlide.diffHunkIds ?? [], hunkMap, assignedIds);

        return {
          id: aiSlide.id,
          slideNumber: aiSlide.slideNumber,
          title: aiSlide.title,
          slideType: aiSlide.slideType,
          narrative: aiSlide.narrative,
          reviewFocus: aiSlide.reviewFocus,
          diffHunks: sortDiffHunks(diffHunks),
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- AI response may omit fields
          contextSnippets: aiSlide.contextSnippets ?? [],
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- AI response may omit fields
          affectedFiles: aiSlide.affectedFiles ?? [],
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- AI response may omit fields
          dependsOn: aiSlide.dependsOn ?? [],
          mermaidDiagram: aiSlide.mermaidDiagram,
          reviewChecks: aiSlide.reviewChecks,
          educationNotes: aiSlide.educationNotes,
          importance: aiSlide.importance ?? 'important',
        };
      });
    }

    const generationDurationMs = Date.now() - generationStart;

    // Sanitize reviewChecks — clear invalid file/line refs so they render as non-clickable
    for (const slide of resolvedSlides) {
      if (!Array.isArray(slide.reviewChecks)) continue;
      const slideFilePaths = new Set(slide.diffHunks.map((h) => h.filePath));

      for (const check of slide.reviewChecks) {
        if (!check.filePath || !slideFilePaths.has(check.filePath)) {
          delete check.filePath;
          delete check.startLine;
          continue;
        }
        if (check.startLine == null || check.startLine <= 0) {
          delete check.filePath;
          delete check.startLine;
          continue;
        }
        // Verify startLine falls within one of the file's hunk ranges
        const fileHunks = slide.diffHunks.filter((h) => h.filePath === check.filePath);
        const lineExists = fileHunks.some((hunk) => {
          const lines = parseDiffLines(hunk.hunkHeader, hunk.content);
          return lines.some((l) => l.lineNumber === check.startLine);
        });
        if (!lineExists) {
          delete check.filePath;
          delete check.startLine;
        }
      }
    }

    // Catch-all slide for unassigned hunks
    const unassigned = indexedHunks.filter((h) => !assignedIds.has(h.id));
    if (unassigned.length > 0) {
      const otherHunks = resolveDiffHunks(unassigned.map((h) => h.id), hunkMap, assignedIds);

      resolvedSlides.push({
        id: 'other-changes',
        slideNumber: resolvedSlides.length + 1,
        title: 'Other changes',
        slideType: 'refactor',
        narrative: 'Additional changes not covered in previous slides.',
        reviewFocus: null,
        diffHunks: sortDiffHunks(otherHunks),
        contextSnippets: [],
        affectedFiles: [...new Set(unassigned.map((h) => h.filePath))],
        dependsOn: [],
        mermaidDiagram: null,
      });
    }

    // Await the file metadata that was kicked off in parallel earlier.
    const fileMetadata = await fileMetadataPromise;

    const reviewGuide: ReviewGuide = {
      prTitle: aiResult?.prTitle || prData.title,
      prDescription: aiResult?.prDescription || prData.description,
      prUrl,
      author: aiResult?.author || prData.author,
      summary: aiResult?.summary || plan?.summary || '',
      riskLevel: aiResult?.riskLevel || plan?.riskLevel || 'low',
      riskRationale: aiResult?.riskRationale || plan?.riskRationale || '',
      totalFilesChanged: changedFiles.length,
      totalLinesChanged: changedFiles.reduce((sum, f) => sum + f.additions + f.deletions, 0),
      neighborFileCount: Object.keys(neighborFiles).length,
      excludedFiles: generatedFiles.length > 0 ? generatedFiles.map((f) => f.filename) : undefined,
      generationDurationMs,
      slides: resolvedSlides,
      headSha: prData.headSha,
      webSources: aiResult?.webSources,
      projectClaudeContext: projectClaudeContext ?? undefined,
      changedFiles: fileMetadata,
    };

    broadcastToAllWindows('review-phase', { reviewId, phase: 'Rendering' });

    // Render syntax-highlighted HTML for each hunk
    const codeTheme = loadPreferences().codeTheme;
    for (const slide of reviewGuide.slides) {
      for (const hunk of slide.diffHunks) {
        try {
          hunk.renderedHtml = await renderDiffHunk(hunk.content, hunk.language, codeTheme, hunk.hunkHeader);
        } catch (err) {
          console.warn(`[main] Failed to render hunk for ${hunk.filePath}:`, err);
          hunk.renderedHtml = `<pre class="diff-block">${hunk.content}</pre>`;
        }
      }
    }

    // Save review JSON and update history entry to completed
    fs.writeFileSync(path.join(getReviewsDir(), `${reviewId}.json`), JSON.stringify(reviewGuide));
    updateHistoryEntry(reviewId, {
      status: 'completed',
      riskLevel: reviewGuide.riskLevel,
      generationDurationMs,
      summary: reviewGuide.summary,
    });

    broadcastToAllWindows('review-completed', { reviewId });

    // Desktop notification
    if (loadPreferences().notifications) {
      const notif = new Notification({
        title: 'Review ready',
        body: prData.title,
        silent: true,
      });
      notif.on('click', () => navigateToReview(reviewId));
      notif.show();
    }

    console.log(`[main] Review ${reviewId} completed in ${formatMs(generationDurationMs)}`);
  } catch (err) {
    const isCancelled = err instanceof Error && err.message === 'GNOSIS_CANCELLED';
    const errorMessage = isCancelled ? 'Cancelled' : err instanceof Error ? err.message : 'Unknown error';
    if (!isCancelled) console.error(`[main] Review ${reviewId} failed:`, errorMessage);

    updateHistoryEntry(reviewId, {
      status: 'failed',
      error: errorMessage,
    });

    broadcastToAllWindows('review-failed', { reviewId, error: errorMessage });
  } finally {
    activeGenerations.delete(reviewId);
  }
}

function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

ipcMain.handle('start-review', async (_event, request: GenerateReviewRequest): Promise<StartReviewResult> => {
  const token = getResolvedToken();
  const octokit = new Octokit({ auth: token ?? undefined });
  const { owner, repo, pullNumber } = parsePrUrl(request.prUrl);

  // Fetch PR metadata (fast, single API call)
  const prData = await getPrMetadata(octokit, owner, repo, pullNumber);

  const reviewId = crypto.randomUUID();
  const prState = prData.merged ? 'merged' : prData.state === 'open' ? 'open' : 'closed';

  // Create pending history entry
  createPendingHistoryEntry(
    reviewId,
    prData.title,
    request.prUrl,
    prData.author,
    request.model,
    prState,
    prData.headSha
  );

  // Cancel any in-flight generation for this PR
  cancelExistingGenerationForPr(request.prUrl);

  // Track and fire off background generation (no await)
  const abortController = new AbortController();
  activeGenerations.set(reviewId, { abortController, prUrl: request.prUrl });
  void runBackgroundGeneration(reviewId, request, prData, abortController.signal);

  return {
    reviewId,
    prTitle: prData.title,
    prUrl: request.prUrl,
    author: prData.author,
  };
});

ipcMain.handle('cancel-review', (_event, reviewId: string) => {
  const gen = activeGenerations.get(reviewId);
  if (gen?.abortController) {
    gen.abortController.abort('User cancelled');
  }
});

ipcMain.handle('send-slide-chat', async (_event, req: SendSlideChatRequest) => {
  const chatProvider = getProvider(req.provider);
  const systemPrompt = buildSlideChatSystemPrompt();
  const userMessage = buildSlideChatUserMessage(req);

  const prefs = loadPreferences();
  let mcpConfigPath: string | undefined;
  let allowedTools: string[] | undefined;

  if (prefs.enableTools && req.provider === 'claude') {
    const token = getResolvedToken();
    if (token) {
      mcpConfigPath = writeMcpConfig(token);
      allowedTools = ALLOWED_TOOLS;
    } else {
      allowedTools = WEB_ONLY_TOOLS;
    }
  } else if (prefs.enableWebResearch && req.provider === 'claude') {
    allowedTools = WEB_ONLY_TOOLS;
  }

  try {
    const result = await chatProvider.generate({
      content: userMessage,
      systemPrompt,
      model: req.model,
      thinking: false,
      onChunk: (chunk, isThinking) => {
        if (!isThinking) {
          _event.sender.send('chat-progress', { chunk });
        }
      },
      onToolUse: (toolName) => _event.sender.send('chat-tool-use', { toolName }),
      mcpConfigPath,
      allowedTools,
    });
    return result;
  } finally {
    if (mcpConfigPath) cleanupMcpConfig(mcpConfigPath);
  }
});

ipcMain.handle('submit-review', async (_event, req: SubmitReviewRequest) => {
  const token = getResolvedToken();
  const octokit = new Octokit({ auth: token ?? undefined });
  const { owner, repo, pullNumber } = parsePrUrl(req.prUrl);

  // Fetch actual PR file patches to validate line numbers.
  // The AI-generated hunks have expanded context (10 lines vs GitHub's 3),
  // so some lines may not be in the real diff.
  const prFiles = await octokit.paginate(octokit.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  const validLinesByFile = new Map<string, Set<string>>();
  for (const file of prFiles) {
    if (file.patch) {
      validLinesByFile.set(file.filename, parsePatchValidLines(file.patch));
    }
  }

  // Partition comments into valid (can be posted as line comments) and
  // dropped (line not in GitHub's diff — folded into review body instead)
  const validComments: typeof req.comments = [];
  const droppedComments: typeof req.comments = [];

  for (const c of req.comments) {
    const validLines = validLinesByFile.get(c.path);
    const key = `${c.line}:${c.side}`;
    if (validLines?.has(key)) {
      validComments.push(c);
    } else {
      droppedComments.push(c);
    }
  }

  // If some comments can't be posted inline, append them to the review body
  let reviewBody = req.body;
  if (droppedComments.length > 0) {
    const droppedText = droppedComments.map((c) => `**${c.path}:${c.line}** — ${c.body}`).join('\n\n');
    const suffix = `\n\n---\n_${droppedComments.length} comment(s) could not be posted inline (lines outside the diff range):_\n\n${droppedText}`;
    reviewBody = (reviewBody || '') + suffix;
  }

  const prefs = loadPreferences();
  if (prefs.reviewSignature) {
    reviewBody = (reviewBody || '') + '\n\n---\n_Reviewed using [gnosis.to](https://gnosis.to)_';
  }

  const { data } = await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    commit_id: req.headSha,
    body: reviewBody,
    event: req.event,
    comments: validComments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side,
      body: c.body,
    })),
  });

  return { reviewUrl: data.html_url, droppedCommentCount: droppedComments.length };
});
