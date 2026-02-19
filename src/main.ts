import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import path from 'path';
import fs from 'fs';
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
} from '../lib/github';
import { buildContextPackage } from '../lib/context-builder';
import { generateReviewGuide } from '../lib/agent';
import { renderDiffHunk, inferLanguage } from '../lib/highlight';
import type { GenerateReviewRequest, ReviewGuide, ReviewHistoryEntry } from '../lib/types';

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

function loadStoredToken(): string | null {
  try {
    const enc = fs.readFileSync(getTokenPath());
    return safeStorage.decryptString(enc);
  } catch {
    return null;
  }
}

function persistToken(token: string) {
  const enc = safeStorage.encryptString(token);
  fs.writeFileSync(getTokenPath(), enc);
}

function deleteStoredToken() {
  const p = getTokenPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function getResolvedToken(): string | null {
  if (cachedToken) return cachedToken;
  return loadStoredToken();
}

// ── Migration ────────────────────────────────────────────────────

function migrateTokenIfNeeded() {
  const tokenPath = getTokenPath();
  if (fs.existsSync(tokenPath)) return; // already migrated

  const configPath = path.join(app.getPath('userData'), 'config.json');
  if (!fs.existsSync(configPath)) return;

  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (cfg.githubToken && typeof cfg.githubToken === 'string') {
      persistToken(cfg.githubToken);
      console.log('[main] Migrated PAT from config.json to safeStorage');
    }
  } catch {
    // ignore
  }
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
        reject(err);
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
      shell.openExternal(`https://github.com/login/oauth/authorize?${params}`);
    });

    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('OAuth sign-in timed out after 5 minutes'));
    }, 5 * 60 * 1000);

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

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
}

app.whenReady().then(() => {
  migrateTokenIfNeeded();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
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
    return JSON.parse(fs.readFileSync(getReviewsIndexPath(), 'utf-8'));
  } catch {
    return [];
  }
}

function saveReviewToHistory(review: ReviewGuide): void {
  ensureReviewsDir();
  const id = Date.now().toString();
  const savedAt = new Date().toISOString();

  fs.writeFileSync(
    path.join(getReviewsDir(), `${id}.json`),
    JSON.stringify(review),
  );

  const entry: ReviewHistoryEntry = {
    id,
    prTitle: review.prTitle,
    prUrl: review.prUrl,
    author: review.author,
    riskLevel: review.riskLevel,
    savedAt,
  };

  const index = readReviewsIndex();
  index.unshift(entry); // newest first
  fs.writeFileSync(getReviewsIndexPath(), JSON.stringify(index, null, 2));
}

// ── IPC handlers ────────────────────────────────────────────────

// Backward-compat shim — renderer still calls getConfig to check if signed in
ipcMain.handle('get-config', async () => {
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

ipcMain.handle('sign-out', async () => {
  cachedToken = null;
  cachedLogin = null;
  deleteStoredToken();
});

ipcMain.handle('list-reviews', async () => {
  return readReviewsIndex();
});

ipcMain.handle('load-review', async (_event, id: string) => {
  const filePath = path.join(getReviewsDir(), `${id}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ReviewGuide;
});

ipcMain.handle('delete-review', async (_event, id: string) => {
  const filePath = path.join(getReviewsDir(), `${id}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  const index = readReviewsIndex().filter((e) => e.id !== id);
  fs.writeFileSync(getReviewsIndexPath(), JSON.stringify(index, null, 2));
});

ipcMain.handle('generate-review', async (_event, { prUrl, model, instructions, thinking }: GenerateReviewRequest) => {
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

  const baseRef = prData.baseBranch;
  const headRef = prData.headSha;

  const fileContents: Record<string, string> = {};
  const headFileContents: Record<string, string> = {};
  const concurrency = 5;
  const filesToFetch = changedFiles.filter((f) => f.status !== 'deleted');
  const filesToFetchBase = changedFiles.filter((f) => f.status !== 'added');

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

  const neighborFiles = await getNeighborFiles(
    octokit,
    owner,
    repo,
    changedFiles.map((f) => f.filename),
    fileContents,
    baseRef,
  );

  const contextPackage = buildContextPackage(
    prData,
    diff,
    changedFiles,
    fileContents,
    headFileContents,
    neighborFiles,
  );

  console.log('[main] Generating review guide...');
  const reviewGuide = await generateReviewGuide(
    contextPackage, prUrl, model, instructions,
    (chunk, isThinking) => _event.sender.send('review-progress', { chunk, isThinking }),
    thinking ?? false,
  );

  reviewGuide.prTitle = reviewGuide.prTitle || prData.title;
  reviewGuide.prDescription = reviewGuide.prDescription || prData.description;
  reviewGuide.author = reviewGuide.author || prData.author;
  reviewGuide.prUrl = prUrl;
  reviewGuide.totalFilesChanged = changedFiles.length;
  reviewGuide.totalLinesChanged = changedFiles.reduce(
    (sum, f) => sum + f.additions + f.deletions,
    0,
  );

  for (const slide of reviewGuide.slides) {
    for (const hunk of slide.diffHunks) {
      if (!hunk.language) {
        hunk.language = inferLanguage(hunk.filePath);
      }
      try {
        hunk.renderedHtml = await renderDiffHunk(hunk.content, hunk.language);
      } catch (err) {
        console.warn(`[main] Failed to render hunk for ${hunk.filePath}:`, err);
        hunk.renderedHtml = `<pre class="diff-block">${hunk.content}</pre>`;
      }
    }
  }

  saveReviewToHistory(reviewGuide);
  return reviewGuide;
});
