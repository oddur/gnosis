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
  getNeighborFiles,
  searchPullRequests,
  getCiStatus,
  getReviewStatus,
} from '../lib/github';
import type { CiCheck, PrStatus } from '../lib/types';
import { buildContextPackage } from '../lib/context-builder';
import { generateReviewGuide } from '../lib/agent';
import { checkForUpdate } from '../lib/updater';
import { renderDiffHunk, reRenderAllHunks } from '../lib/highlight';
import { parseDiffLines, parsePatchValidLines } from '../lib/diff-lines';
import { setBinaryOverride, detectBinaryPath, resolveBinaryPath } from '../lib/providers/shared';
import { getProvider } from '../lib/provider';
import { buildSlideChatSystemPrompt, buildSlideChatUserMessage } from '../lib/chat-agent';
import { buildIndexedHunks, expandFullDiff, formatHunkIndexForPrompt, sortDiffHunks } from '../lib/diff-parse';
import { classifyFiles, filterDiff, buildExcludedFilesSummary } from '../lib/file-filter';
import { writeMcpConfig, cleanupMcpConfig } from '../lib/mcp-config';
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

// ── Auto-review on reviewer assignment ──────────────────────────

const AUTO_REVIEW_POLL_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes
const AUTO_REVIEW_MAX_AGE_MS = 24 * 60 * 60 * 1_000; // ignore PRs not updated within 24 h

function getSeenReviewRequestsPath() {
  return path.join(app.getPath('userData'), 'seen-review-requests.json');
}

function loadSeenReviewRequests(): Set<string> {
  try {
    const data = JSON.parse(fs.readFileSync(getSeenReviewRequestsPath(), 'utf-8')) as string[];
    return new Set(data);
  } catch {
    return new Set();
  }
}

function saveSeenReviewRequests(seen: Set<string>) {
  fs.writeFileSync(getSeenReviewRequestsPath(), JSON.stringify([...seen], null, 2));
}

// Loaded once into memory; updated as reviews are triggered
let seenReviewRequests = new Set<string>();

async function triggerBackgroundReview(prUrl: string, prefs: Preferences): Promise<void> {
  // cachedToken is guaranteed non-null by the caller (runAutoReviewCheck).
  console.log(`[auto-review] Starting background review for ${prUrl}`);
  const reviewId = crypto.randomUUID();

  try {
    const octokit = new Octokit({ auth: cachedToken ?? undefined });
    const { owner, repo, pullNumber } = parsePrUrl(prUrl);
    const prData = await getPrMetadata(octokit, owner, repo, pullNumber);

    const abortController = new AbortController();
    createPendingHistoryEntry(reviewId, prData.title, prUrl, prData.author, prefs.model, 'open', prData.headSha, true);
    activeGenerations.set(reviewId, { abortController });

    const request: GenerateReviewRequest = {
      prUrl,
      provider: prefs.provider,
      model: prefs.model,
      instructions: prefs.instructions,
      thinking: prefs.thinking,
      signalBoost: prefs.signalBoost,
      smartImports: prefs.smartImports,
      reviewSuggestions: prefs.reviewSuggestions,
    };

    await runBackgroundGeneration(reviewId, request, prData, abortController.signal);

    // Refresh the history list in all open windows
    broadcastToAllWindows('new-review-in-history');
    console.log(`[auto-review] Completed review for ${prUrl}`);
  } catch (err) {
    console.error(`[auto-review] Failed to start background review for ${prUrl}:`, err);
  }
}

async function runAutoReviewCheck() {
  // Use only in-memory state — never touch the keychain from a background timer.
  // cachedToken and cachedLogin are populated when the user authenticates via IPC.
  if (!cachedToken || !cachedLogin) return;
  const prefs = loadPreferences();
  if (!prefs.autoReviewOnRequest) return;

  try {
    const octokit = new Octokit({ auth: cachedToken });
    const prs = await searchPullRequests(octokit, cachedLogin);
    // searchPullRequests already queries `is:open`, so merged/closed PRs are excluded
    const reviewRequested = prs.filter((pr) => pr.role === 'review-requested');
    const now = Date.now();

    for (const pr of reviewRequested) {
      if (!seenReviewRequests.has(pr.url)) {
        // Always mark as seen so we never trigger the same PR twice
        seenReviewRequests.add(pr.url);
        saveSeenReviewRequests(seenReviewRequests);

        // Only review PRs updated in the last 24 h — avoids flooding on first enable
        const updatedAt = new Date(pr.updatedAt).getTime();
        if (now - updatedAt <= AUTO_REVIEW_MAX_AGE_MS) {
          void triggerBackgroundReview(pr.url, prefs);
        } else {
          console.log(`[auto-review] Skipping stale PR (${Math.round((now - updatedAt) / 3_600_000)}h old): ${pr.url}`);
        }
      }
    }
  } catch (err) {
    console.error('[auto-review] Poll check failed:', err);
  }
}

let autoReviewInterval: ReturnType<typeof setInterval> | null = null;

function startAutoReviewPolling() {
  if (autoReviewInterval) return;
  seenReviewRequests = loadSeenReviewRequests();
  // Initial check after 10 seconds to let the app fully initialize
  setTimeout(() => void runAutoReviewCheck(), 10_000);
  autoReviewInterval = setInterval(() => void runAutoReviewCheck(), AUTO_REVIEW_POLL_INTERVAL_MS);
}

function stopAutoReviewPolling() {
  if (autoReviewInterval) {
    clearInterval(autoReviewInterval);
    autoReviewInterval = null;
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

  // Mark any stale "generating" entries from a previous crash as failed
  cleanupStaleGeneratingEntries();
  applyBinaryOverrides(loadPreferences());
  createWindow();
  setupAutoUpdater();

  // GitHub release polling only needed on Linux (no native auto-update)
  if (process.platform === 'linux') {
    startUpdateChecks();
  }

  startAutoReviewPolling();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    if (!updateInterval && process.platform === 'linux') startUpdateChecks();
    if (!autoReviewInterval) startAutoReviewPolling();
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
});

app.on('window-all-closed', () => {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
  stopAutoReviewPolling();
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

function readReviewsIndex(): ReviewHistoryEntry[] {
  try {
    const entries = JSON.parse(fs.readFileSync(getReviewsIndexPath(), 'utf-8')) as ReviewHistoryEntry[];
    // Backward compat: entries without status are completed
    return entries.map((e) => ({ ...e, status: e.status ?? 'completed' }));
  } catch {
    return [];
  }
}

// ── Background generation tracking ──────────────────────────────

const activeGenerations = new Map<string, { abortController?: AbortController }>();

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
}

function updateHistoryEntry(id: string, updates: Partial<ReviewHistoryEntry>): void {
  const index = readReviewsIndex();
  const idx = index.findIndex((e) => e.id === id);
  if (idx === -1) return;
  index[idx] = { ...index[idx], ...updates };
  fs.writeFileSync(getReviewsIndexPath(), JSON.stringify(index, null, 2));
}

function broadcastToAllWindows(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args);
  }
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
  model: 'claude-opus-4-6',
  thinking: true,
  signalBoost: true,
  smartImports: true,
  reviewSuggestions: true,
  enableTools: false,
  enableWebResearch: false,
  autoReviewOnRequest: false,
  codeTheme: 'aurora-x',
  codeFont: 'jetbrains-mono',
  claudePath: '',
  geminiPath: '',
  notifications: true,
  diffLayout: 'unified',
  includeAllFiles: true,
  reviewSignature: true,
};

function applyBinaryOverrides(prefs: Preferences): void {
  setBinaryOverride('claude', prefs.claudePath);
  setBinaryOverride('gemini', prefs.geminiPath);
}

function loadPreferences(): Preferences {
  try {
    const stored = JSON.parse(fs.readFileSync(getPreferencesPath(), 'utf-8')) as Partial<Preferences>;
    return { ...DEFAULT_PREFERENCES, ...stored };
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
  const octokit = new Octokit({ auth: token });
  return searchPullRequests(octokit, cachedLogin);
});

ipcMain.handle('load-preferences', () => {
  return loadPreferences();
});

ipcMain.handle('save-preferences', (_event, prefs: Preferences) => {
  savePreferences(prefs);
  applyBinaryOverrides(prefs);
  // Restart polling so the new autoReviewOnRequest value takes effect immediately
  stopAutoReviewPolling();
  if (prefs.autoReviewOnRequest) startAutoReviewPolling();
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
  const index = readReviewsIndex().map((e) => (e.id === id ? { ...e, unread: false } : e));
  fs.writeFileSync(getReviewsIndexPath(), JSON.stringify(index, null, 2));
});

ipcMain.handle('delete-review', (_event, id: string) => {
  const reviewPath = path.join(getReviewsDir(), `${id}.json`);
  const promptPath = path.join(getReviewsDir(), `${id}-prompt.md`);
  if (fs.existsSync(reviewPath)) fs.unlinkSync(reviewPath);
  if (fs.existsSync(promptPath)) fs.unlinkSync(promptPath);
  const index = readReviewsIndex().filter((e) => e.id !== id);
  fs.writeFileSync(getReviewsIndexPath(), JSON.stringify(index, null, 2));
});

ipcMain.handle('delete-all-reviews', () => {
  const dir = getReviewsDir();
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('.json') || file.endsWith('-prompt.md')) fs.unlinkSync(path.join(dir, file));
    }
  }
  fs.writeFileSync(getReviewsIndexPath(), JSON.stringify([], null, 2));
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

ipcMain.handle('get-pr-status', async (_event, prUrl: string): Promise<PrStatus> => {
  const token = getResolvedToken();
  const octokit = new Octokit({ auth: token ?? undefined });
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
});

ipcMain.handle(
  'get-pr-state',
  async (_event, prUrl: string): Promise<{ prState: 'open' | 'merged' | 'closed'; headSha: string }> => {
    const token = getResolvedToken();
    const octokit = new Octokit({ auth: token ?? undefined });
    const { owner, repo, pullNumber } = parsePrUrl(prUrl);
    const prData = await getPrMetadata(octokit, owner, repo, pullNumber);
    const prState = prData.merged ? 'merged' : prData.state === 'open' ? 'open' : 'closed';
    return { prState, headSha: prData.headSha };
  }
);

ipcMain.handle('get-pr-files', async (_event, prUrl: string): Promise<ChangedFile[]> => {
  const token = getResolvedToken();
  const octokit = new Octokit({ auth: token ?? undefined });
  const { owner, repo, pullNumber } = parsePrUrl(prUrl);
  return getChangedFiles(octokit, owner, repo, pullNumber);
});

// ── Background review generation ────────────────────────────────

async function runBackgroundGeneration(
  reviewId: string,
  request: GenerateReviewRequest,
  prData: Awaited<ReturnType<typeof getPrMetadata>>,
  signal: AbortSignal
): Promise<void> {
  const { prUrl, provider, model, instructions, thinking, signalBoost, smartImports, reviewSuggestions, webResearch } =
    request;

  try {
    const token = getResolvedToken();
    const octokit = new Octokit({ auth: token ?? undefined });
    const { owner, repo, pullNumber } = parsePrUrl(prUrl);

    broadcastToAllWindows('review-phase', { reviewId, phase: 'Fetching PR data' });

    const [diff, allChangedFiles] = await Promise.all([
      getPrDiff(octokit, owner, repo, pullNumber),
      getChangedFiles(octokit, owner, repo, pullNumber),
    ]);

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
    const neighborFiles = await getNeighborFiles(
      octokit,
      owner,
      repo,
      normalFiles.map((f) => f.filename),
      allFileContents,
      baseRef,
      smartImports ? provider : undefined
    );

    broadcastToAllWindows('review-phase', { reviewId, phase: 'Building context' });

    // Parse diff into indexed hunks and build expanded diff (using filtered diff)
    const indexedHunks = buildIndexedHunks(filteredDiff, fileContents, headFileContents);
    const expandedDiff = expandFullDiff(filteredDiff, fileContents, headFileContents);
    const hunkIndex = formatHunkIndexForPrompt(indexedHunks);

    const contextPackage = buildContextPackage(
      prData,
      expandedDiff,
      changedFiles,
      fileContents,
      headFileContents,
      neighborFiles,
      hunkIndex,
      excludedFilesSummary
    );

    broadcastToAllWindows('review-phase', { reviewId, phase: 'Generating review' });

    console.log(`[main] Generating review guide (${reviewId})...`);
    const generationStart = Date.now();

    const prefs = loadPreferences();
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

    let aiResult;
    let lastStreamPhase: string | null = null;
    try {
      aiResult = await generateReviewGuide(
        contextPackage,
        prUrl,
        provider,
        model,
        instructions,
        (chunk, isThinking) => {
          const phase = isThinking ? 'Thinking' : 'Generating review';
          if (phase !== lastStreamPhase) {
            lastStreamPhase = phase;
            broadcastToAllWindows('review-phase', { reviewId, phase });
          }
          broadcastToAllWindows('review-progress', { reviewId, chunk, isThinking });
        },
        thinking ?? false,
        signalBoost ?? false,
        mcpConfigPath,
        allowedTools,
        reviewSuggestions ?? true,
        webResearch ?? false,
        (toolName) => broadcastToAllWindows('review-tool-use', { reviewId, toolName }),
        (system, userMessage) => {
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
            // Best-effort — don't fail the review if prompt save fails
          }
        },
        signal
      );
    } finally {
      if (mcpConfigPath) cleanupMcpConfig(mcpConfigPath);
    }

    const generationDurationMs = Date.now() - generationStart;

    // Append raw model response to prompt file (best-effort)
    try {
      const promptPath = path.join(getReviewsDir(), `${reviewId}-prompt.md`);
      if (fs.existsSync(promptPath)) {
        fs.appendFileSync(
          promptPath,
          `\n---\n\n# Model Response\n\n\`\`\`json\n${JSON.stringify(aiResult, null, 2)}\n\`\`\`\n`
        );
      }
    } catch {
      // Best-effort
    }

    // Resolve hunk IDs → real DiffHunk objects
    const hunkMap = new Map(indexedHunks.map((h) => [h.id, h]));
    const assignedIds = new Set<string>();

    const resolvedSlides: Slide[] = aiResult.slides.map((aiSlide) => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- AI response may omit fields
      const ids = aiSlide.diffHunkIds ?? [];
      const diffHunks: DiffHunk[] = ids
        .filter((id: string) => hunkMap.has(id) && !assignedIds.has(id))
        .map((id: string) => {
          assignedIds.add(id);
          const h = hunkMap.get(id);
          if (!h) throw new Error(`Hunk ${id} not found in index`);
          return {
            filePath: h.filePath,
            hunkHeader: h.expandedHunkHeader,
            content: h.expandedContent,
            language: h.language,
            renderedHtml: '',
          };
        });

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
      };
    });

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
      const otherHunks: DiffHunk[] = unassigned.map((h) => ({
        filePath: h.filePath,
        hunkHeader: h.expandedHunkHeader,
        content: h.expandedContent,
        language: h.language,
        renderedHtml: '',
      }));

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

    const reviewGuide: ReviewGuide = {
      prTitle: aiResult.prTitle || prData.title,
      prDescription: aiResult.prDescription || prData.description,
      prUrl,
      author: aiResult.author || prData.author,
      summary: aiResult.summary,
      riskLevel: aiResult.riskLevel,
      riskRationale: aiResult.riskRationale,
      totalFilesChanged: changedFiles.length,
      totalLinesChanged: changedFiles.reduce((sum, f) => sum + f.additions + f.deletions, 0),
      neighborFileCount: Object.keys(neighborFiles).length,
      excludedFiles: generatedFiles.length > 0 ? generatedFiles.map((f) => f.filename) : undefined,
      generationDurationMs,
      slides: resolvedSlides,
      headSha: prData.headSha,
      webSources: aiResult.webSources,
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
    });

    broadcastToAllWindows('review-completed', { reviewId });

    // Desktop notification
    if (loadPreferences().notifications) {
      const notif = new Notification({
        title: 'Review ready',
        body: prData.title,
        silent: true,
      });
      notif.on('click', () => {
        broadcastToAllWindows('review-navigate', { reviewId });
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
          const win = windows[0];
          if (win.isMinimized()) win.restore();
          win.focus();
        }
      });
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

  // Track and fire off background generation (no await)
  const abortController = new AbortController();
  activeGenerations.set(reviewId, { abortController });
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
