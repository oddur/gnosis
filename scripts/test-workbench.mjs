import { build } from 'esbuild';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import electron from 'electron';
import { setTimeout, clearTimeout } from 'node:timers';
const prBadgePreviews = process.argv.includes('--pr-badge-previews');
const fileFilters = process.argv.includes('--file-filters');
const navigationHistory = process.argv.includes('--navigation-history') || process.argv.includes('--navigation-swipe');
const entityBadges = process.argv.includes('--entity-badges');
const markdownReview = process.argv.includes('--markdown-review');
const targetBranch = process.argv.includes('--target-branch');
const labelFilter = process.argv.includes('--label-filter');
const sorting = process.argv.includes('--sorting');
const preloadActivity = process.argv.includes('--preload-activity');
const unread = process.argv.includes('--unread');
const reviewEntryPoints = process.argv.includes('--review-entry-points');
const contextMenus = process.argv.includes('--context-menus');
const d2 = process.argv.includes('--d2');
const mermaid = process.argv.includes('--mermaid');
const prActions = process.argv.includes('--pr-actions');
const breadcrumbs = process.argv.includes('--breadcrumbs');
const lfs = process.argv.includes('--lfs');
const selections = process.argv.includes('--selections');
const shellHardening = process.argv.includes('--shell-hardening');
const setupHardening = process.argv.includes('--setup-hardening');
const inspectionHardening = process.argv.includes('--inspection-hardening');
const cacheReset = process.argv.includes('--cache-reset');
const localClones = process.argv.includes('--local-clones');
const preload = process.argv.includes('--preload');
const sync = process.argv.includes('--sync');
const inactivity = process.argv.includes('--inactivity');
const mutes = process.argv.includes('--mutes');
const stars = process.argv.includes('--stars');
const readiness = process.argv.includes('--readiness');
const diffContext = process.argv.includes('--diff-context');
const explanation = process.argv.includes('--explanation');
const diffSpeed = process.argv.includes('--diff-speed');
const commits = process.argv.includes('--commits');
const changes = process.argv.includes('--changes');
const queueMetadata = process.argv.includes('--queue-metadata');
const authors = process.argv.includes('--authors');
const commandCenter = process.argv.includes('--commands');
const performance = process.argv.includes('--performance');
const polish = process.argv.includes('--polish');
const hardening = process.argv.includes('--hardening');
const auth = process.argv.includes('--auth');
const onboarding = process.argv.includes('--onboarding');
const images = process.argv.includes('--images');
const splitDiff = process.argv.includes('--split-diff');
const threads = process.argv.includes('--threads');
const prSummary = process.argv.includes('--pr-summary');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-workbench-test-'));
const server = await createServer({ configFile: 'vite.renderer.config.ts', server: { host: '127.0.0.1', port: 0 } });
try {
  await server.listen();
  const address = server.httpServer.address();
  const outfile = path.join(dir, 'test.cjs');
  await build({
    entryPoints: [
      process.argv.includes('--folder-viewed') ? 'tests/folder-viewed-browser.ts' : process.argv.includes('--highlighter-settings') ? 'tests/highlighter-settings-browser.ts' : process.argv.includes('--moved-files') ? 'tests/moved-files-browser.ts' : process.argv.includes('--inspection-scroll') ? 'tests/inspection-scroll-browser.ts' : process.argv.includes('--stack-changes') ? 'tests/stack-changes-browser.ts' : process.argv.includes('--illustrations') ? 'tests/svg-illustration-browser.ts' : process.argv.includes('--mechanisms') ? 'tests/mechanism-browser.ts' : process.argv.includes('--ftue') ? 'tests/onboarding-setup-browser.ts' : process.argv.includes('--harness-environment') ? 'tests/harness-environment-browser.ts' : process.argv.includes('--comment-editor') ? 'tests/comment-editor-browser.ts' : process.argv.includes('--chat') ? 'tests/chat-browser.ts' : process.argv.includes('--stack-layout') ? 'tests/stack-layout-browser.ts' : process.argv.includes('--stack-hierarchy') ? 'tests/stack-hierarchy-browser.ts' : process.argv.includes('--checks') ? 'tests/pr-checks-browser.ts' : markdownReview ? 'tests/markdown-review-browser.ts' : targetBranch ? 'tests/target-branch-browser.ts' : prBadgePreviews ? 'tests/pr-badge-previews-browser.ts' : fileFilters ? 'tests/file-filters-browser.ts' : navigationHistory ? 'tests/navigation-history-browser.ts' : entityBadges ? 'tests/entity-badges-browser.ts' : labelFilter ? 'tests/label-filter-browser.ts' : sorting ? 'tests/pr-list-sort-browser.ts' : preloadActivity ? 'tests/preload-activity-browser.ts' : unread ? 'tests/unread-prs-browser.ts' : reviewEntryPoints ? 'tests/review-entry-points-browser.ts' : contextMenus ? 'tests/context-menus-browser.ts' : d2 ? 'tests/d2-browser.ts' : mermaid ? 'tests/mermaid-browser.ts' : prActions ? 'tests/pr-actions-browser.ts' : breadcrumbs ? 'tests/breadcrumbs-browser.ts' : lfs ? 'tests/git-lfs-browser.ts' : selections ? 'tests/searchable-selection-browser.ts' : shellHardening ? 'tests/shell-hardening-browser.ts' : setupHardening ? 'tests/setup-hardening-browser.ts' : inspectionHardening ? 'tests/inspection-hardening-browser.ts' : localClones ? 'tests/local-clones-browser.ts' : cacheReset ? 'tests/github-cache-reset-browser.ts' : preload ? 'tests/pr-preload-browser.ts' : sync ? 'tests/github-sync-browser.ts' : inactivity ? 'tests/pr-inactivity-browser.ts' : mutes ? 'tests/muted-prs-browser.ts' : stars ? 'tests/starred-prs-browser.ts' : readiness ? 'tests/merge-readiness-browser.ts' : diffContext ? 'tests/diff-context-browser.ts' : explanation ? 'tests/explanation-tab-browser.ts' : diffSpeed ? 'tests/diff-navigation-browser.ts' : commits ? 'tests/pr-commits-browser.ts' : changes ? 'tests/pr-changes-browser.ts' : queueMetadata ? 'tests/queue-metadata-browser.ts' : authors ? 'tests/github-author-browser.ts' : commandCenter ? 'tests/command-center-browser.ts' : performance ? 'tests/queue-performance-browser.ts' : polish
        ? 'tests/polish-browser.ts'
        : hardening
          ? 'tests/hardening-browser.ts'
          : auth
            ? 'tests/github-auth-browser.ts'
            : onboarding
              ? 'tests/onboarding-browser.ts'
              : images
                ? 'tests/review-images-browser.ts'
                : prSummary
                  ? 'tests/pr-summary-browser.ts'
                  : threads
                    ? 'tests/review-threads-browser.ts'
                    : splitDiff
                      ? 'tests/split-diff-browser.ts'
                      : 'tests/workbench-browser.ts',
    ],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  if (markdownReview) await build({ entryPoints: ['src/markdown-review-worker.ts'], outfile: path.join(dir, 'markdown-review-worker.cjs'), bundle: true, platform: 'node', format: 'cjs' });
  const env = {
    ...process.env,
    GNOSIS_NATIVE_SWIPE: process.argv.includes('--navigation-swipe') ? '1' : process.env.GNOSIS_NATIVE_SWIPE,
    GNOSIS_WORKBENCH_URL: `http://127.0.0.1:${address.port}/tests/fixtures/${splitDiff ? 'split-diff' : 'workbench'}.html`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [outfile], { env, stdio: 'inherit' });
    const timer = setTimeout(
      () => {
        child.kill();
        reject(new Error('Workbench browser checks timed out'));
      },
      splitDiff || threads ? 90000 : prSummary ? 180000 : 300000
    );
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (code !== 0) process.exitCode = 1;
} finally {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
