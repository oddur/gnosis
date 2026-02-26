import { app, BrowserWindow, ipcMain, Notification, safeStorage, shell } from 'electron';
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
  DiffHunk,
  GenerateReviewRequest,
  ModelId,
  Preferences,
  ReviewGuide,
  ReviewHistoryEntry,
  Slide,
  SendSlideChatRequest,
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
  try {
    if (safeStorage.isEncryptionAvailable() && fs.existsSync(getTokenPath())) {
      return safeStorage.decryptString(fs.readFileSync(getTokenPath()));
    }
    if (fs.existsSync(getPlainTokenPath())) {
      return fs.readFileSync(getPlainTokenPath(), 'utf-8').trim();
    }
    return null;
  } catch {
    return null;
  }
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

// ── Window ───────────────────────────────────────────────────────

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

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

// ── Update check helpers ─────────────────────────────────────

let dismissedUpdateVersion: string | null = null;

async function runUpdateCheck() {
  const update = await checkForUpdate(app.getVersion());
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

async function triggerBackgroundReview(prUrl: string, prefs: Preferences, prTitle: string): Promise<void> {
  const token = getResolvedToken();
  const octokit = new Octokit({ auth: token ?? undefined });
  const { owner, repo, pullNumber } = parsePrUrl(prUrl);

  try {
    console.log(`[auto-review] Starting background review for ${prUrl}`);

    const [prData, diff, changedFiles] = await Promise.all([
      getPrMetadata(octokit, owner, repo, pullNumber),
      getPrDiff(octokit, owner, repo, pullNumber),
      getChangedFiles(octokit, owner, repo, pullNumber),
    ]);

    if (changedFiles.length === 0) {
      console.warn(`[auto-review] PR has no changed files: ${prUrl}`);
      return;
    }

    const { normalFiles, generatedFiles } = classifyFiles(changedFiles);
    const generatedFilenames = new Set(generatedFiles.map((f) => f.filename));
    const filteredDiff = filterDiff(diff, generatedFilenames);
    const excludedFilesSummary = buildExcludedFilesSummary(generatedFiles);

    const baseRef = prData.baseBranch;
    const headRef = prData.headSha;

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

    const allFileContents = { ...fileContents, ...headFileContents };
    const neighborFiles = await getNeighborFiles(
      octokit,
      owner,
      repo,
      normalFiles.map((f) => f.filename),
      allFileContents,
      baseRef,
      prefs.smartImports ? prefs.provider : undefined
    );

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

    const generationStart = Date.now();
    const aiResult = await generateReviewGuide(
      contextPackage,
      prUrl,
      prefs.provider,
      prefs.model,
      prefs.instructions,
      () => {}, // no streaming for background reviews
      prefs.thinking,
      prefs.signalBoost,
      undefined,
      undefined,
      prefs.reviewSuggestions,
      false,
      () => {}
    );
    const generationDurationMs = Date.now() - generationStart;

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

    const codeTheme = loadPreferences().codeTheme;
    for (const slide of reviewGuide.slides) {
      for (const hunk of slide.diffHunks) {
        try {
          hunk.renderedHtml = await renderDiffHunk(hunk.content, hunk.language, codeTheme, hunk.hunkHeader);
        } catch {
          hunk.renderedHtml = `<pre class="diff-block">${hunk.content}</pre>`;
        }
      }
    }

    saveReviewToHistory(reviewGuide, prefs.model, true);
    console.log(`[auto-review] Completed review for ${prUrl}`);

    // Tell open windows to refresh their history list
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send('new-review-in-history');
    }

    // Show native OS notification; clicking just surfaces the app
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: 'Review ready',
        body: prTitle || reviewGuide.prTitle,
        silent: false,
      });
      notification.on('click', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          if (win.isMinimized()) win.restore();
          win.focus();
          win.webContents.send('new-review-in-history');
        }
      });
      notification.show();
    }
  } catch (err) {
    console.error(`[auto-review] Failed to generate review for ${prUrl}:`, err);
  }
}

async function runAutoReviewCheck() {
  // cachedLogin is populated by get-auth-state IPC on renderer load.
  // Checking it first avoids a keychain access when the user isn't authenticated yet.
  if (!cachedLogin) return;
  const token = getResolvedToken();
  if (!token) return;
  const prefs = loadPreferences();
  if (!prefs.autoReviewOnRequest) return;

  try {
    const octokit = new Octokit({ auth: token });
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
          void triggerBackgroundReview(pr.url, prefs, pr.title);
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

void app.whenReady().then(() => {
  applyBinaryOverrides(loadPreferences());
  createWindow();
  startUpdateChecks();
  startAutoReviewPolling();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    if (!updateInterval) startUpdateChecks();
    if (!autoReviewInterval) startAutoReviewPolling();
  });
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
    return JSON.parse(fs.readFileSync(getReviewsIndexPath(), 'utf-8')) as ReviewHistoryEntry[];
  } catch {
    return [];
  }
}

function saveReviewToHistory(review: ReviewGuide, model?: ModelId, unread?: boolean): void {
  ensureReviewsDir();
  const id = Date.now().toString();
  const savedAt = new Date().toISOString();

  fs.writeFileSync(path.join(getReviewsDir(), `${id}.json`), JSON.stringify(review));

  const entry: ReviewHistoryEntry = {
    id,
    prTitle: review.prTitle,
    prUrl: review.prUrl,
    author: review.author,
    riskLevel: review.riskLevel,
    model,
    generationDurationMs: review.generationDurationMs,
    savedAt,
    ...(unread ? { unread: true } : {}),
  };

  const index = readReviewsIndex();
  index.unshift(entry); // newest first
  fs.writeFileSync(getReviewsIndexPath(), JSON.stringify(index, null, 2));
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
  diffLayout: 'unified',
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

// Backward-compat shim — renderer still calls getConfig to check if signed in
ipcMain.handle('get-config', () => {
  const token = getResolvedToken();
  return { githubToken: token };
});

ipcMain.handle('start-oauth', async () => {
  await runOAuthFlow();
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
  const extra = name === 'claude' ? [`${os.homedir()}/.volta/bin/claude`] : [];
  return detectBinaryPath(name, extra);
});

ipcMain.handle('check-cli-installed', (_event, provider: string) => {
  const extra = provider === 'claude' ? [`${os.homedir()}/.volta/bin/claude`] : [];
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
  const filePath = path.join(getReviewsDir(), `${id}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  const index = readReviewsIndex().filter((e) => e.id !== id);
  fs.writeFileSync(getReviewsIndexPath(), JSON.stringify(index, null, 2));
});

ipcMain.handle('delete-all-reviews', () => {
  const dir = getReviewsDir();
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('.json')) fs.unlinkSync(path.join(dir, file));
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
    const octokit = new Octokit({ auth: token ?? undefined });
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
  'generate-review',
  async (
    _event,
    {
      prUrl,
      provider,
      model,
      instructions,
      thinking,
      signalBoost,
      smartImports,
      reviewSuggestions,
      webResearch,
    }: GenerateReviewRequest
  ) => {
    const token = getResolvedToken();
    const octokit = new Octokit({ auth: token ?? undefined });

    const { owner, repo, pullNumber } = parsePrUrl(prUrl);

    const [prData, diff, changedFiles] = await Promise.all([
      getPrMetadata(octokit, owner, repo, pullNumber),
      getPrDiff(octokit, owner, repo, pullNumber),
      getChangedFiles(octokit, owner, repo, pullNumber),
    ]);

    if (changedFiles.length === 0) {
      throw new Error('PR has no changed files');
    }

    // Filter out generated/lock files early to avoid token budget blowup
    const { normalFiles, generatedFiles } = classifyFiles(changedFiles);
    const generatedFilenames = new Set(generatedFiles.map((f) => f.filename));
    const filteredDiff = filterDiff(diff, generatedFilenames);
    const excludedFilesSummary = buildExcludedFilesSummary(generatedFiles);

    if (generatedFiles.length > 0) {
      console.log(
        `[main] Filtered ${generatedFiles.length} generated file(s):`,
        generatedFiles.map((f) => f.filename)
      );
    }

    const baseRef = prData.baseBranch;
    const headRef = prData.headSha;

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

    console.log('[main] Generating review guide...');
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
    try {
      aiResult = await generateReviewGuide(
        contextPackage,
        prUrl,
        provider,
        model,
        instructions,
        (chunk, isThinking) => _event.sender.send('review-progress', { chunk, isThinking }),
        thinking ?? false,
        signalBoost ?? false,
        mcpConfigPath,
        allowedTools,
        reviewSuggestions ?? true,
        webResearch ?? false,
        (toolName) => _event.sender.send('review-tool-use', { toolName })
      );
    } finally {
      if (mcpConfigPath) cleanupMcpConfig(mcpConfigPath);
    }

    const generationDurationMs = Date.now() - generationStart;

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
          // Safe: filter above guarantees hunkMap.has(id)
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

    saveReviewToHistory(reviewGuide, model);
    return reviewGuide;
  }
);

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
