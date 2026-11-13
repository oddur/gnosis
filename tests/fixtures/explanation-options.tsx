import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import '../../src/globals.css';
import { ExplanationSetupDialog } from '../../components/ExplanationSetupDialog';
import { explanationFile, normalizeExplanationOptions } from '../../lib/explanation-options';
import type { GenerateReviewRequest } from '../../lib/types';
import type { ExplanationSetupUpdate } from '../../lib/explanation-options';
const params = new URLSearchParams(location.search);
const requests: GenerateReviewRequest[] = Array.from({ length: params.has('bulk') ? 2 : 1 }, (_, i) => ({
  prUrl: `https://github.com/org/repo/pull/${i + 1}`,
  provider: 'claude',
  model: 'claude-opus-5-5',
  instructions: 'Global instructions',
}));
let failedLoad = false;
// Records whether the loading state ever showed, so a saved answer can prove it never flashed.
new MutationObserver(() => {
  if (document.body.textContent.includes('Preparing explanation options')) document.documentElement.dataset.loadingSeen = 'true';
}).observe(document.body, { subtree: true, childList: true, characterData: true });
let updateListener: ((update: ExplanationSetupUpdate) => void) | undefined;
const pushedFiles = ['src/queue.ts', 'src/queue.test.ts', 'generated/schema.ts', 'src/worker.ts', 'src/worker.test.ts'];
/** Main's answer after GitHub shows a push: CHANGELOG.md left the PR and the worker files joined it. */
Object.assign(window, {
  simulatePush: () =>
    updateListener?.({
      updateId: 'saved-1',
      setup: {
        title: 'Keep worker commands in order',
        repository: 'org/repo',
        restored: false,
        updateId: 'saved-1',
        options: normalizeExplanationOptions(undefined),
        files: pushedFiles.map((path) =>
          explanationFile({ filename: path, status: 'modified', additions: 4, deletions: 1 }, path, '#120 Keep worker commands in order')
        ),
      },
    }),
});
window.electronAPI = {
  onExplanationSetupUpdate: (callback) => {
    updateListener = callback;
    return () => {
      updateListener = undefined;
    };
  },
  getExplanationSetup: async (request) => {
    if (params.has('load-error') && !failedLoad) {
      failedLoad = true;
      throw Error('Could not read files. Try again.');
    }
    if (params.has('slow')) await new Promise((resolve) => setTimeout(resolve, 800));
    return {
      ...(params.has('saved') ? { updateId: 'saved-1' } : {}),
      title: request.prUrl.endsWith('/2') ? 'Update the reader' : 'Keep worker commands in order',
      repository: 'org/repo',
      restored: params.has('restore'),
      options: normalizeExplanationOptions(
        params.has('restore')
          ? { style: 'educational', excludeTests: true, fileOverrides: { 'generated/schema.ts': true } }
          : undefined
      ),
      files: ['src/queue.ts', 'src/queue.test.ts', 'generated/schema.ts', 'CHANGELOG.md'].map((path) =>
        explanationFile(
          { filename: path, status: 'modified', additions: 4, deletions: 1 },
          path,
          '#120 Keep worker commands in order'
        )
      ),
    };
  },
} as typeof window.electronAPI;
let failed = false;
function Fixture() {
  const [closed, setClosed] = useState(false);
  return closed ? (
    <p data-closed>Closed</p>
  ) : (
    <ExplanationSetupDialog
      requests={requests}
      onGenerate={async (request) => {
        const attempts = JSON.parse(sessionStorage.getItem('attempts') ?? '[]') as GenerateReviewRequest[];
        attempts.push(request);
        sessionStorage.setItem('attempts', JSON.stringify(attempts));
        if (params.has('start-error') && !failed && request.prUrl.endsWith('/' + (params.has('bulk') ? '2' : '1'))) {
          failed = true;
          throw Error('Harness unavailable. Try again.');
        }
        sessionStorage.setItem('successful', String(Number(sessionStorage.getItem('successful') ?? 0) + 1));
      }}
      onClose={(started) => {
        document.body.dataset.started = String(started);
        setClosed(true);
      }}
    />
  );
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<Fixture />);
