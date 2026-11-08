import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import '../../src/globals.css';
import { ExplanationSetupDialog } from '../../components/ExplanationSetupDialog';
import { explanationFile, normalizeExplanationOptions } from '../../lib/explanation-options';
import type { GenerateReviewRequest } from '../../lib/types';
const params = new URLSearchParams(location.search);
const requests: GenerateReviewRequest[] = Array.from({ length: params.has('bulk') ? 2 : 1 }, (_, i) => ({
  prUrl: `https://github.com/org/repo/pull/${i + 1}`,
  provider: 'claude',
  model: 'claude-opus-5-5',
  instructions: 'Global instructions',
}));
let failedLoad = false;
window.electronAPI = {
  getExplanationSetup: async (request) => {
    if (params.has('load-error') && !failedLoad) {
      failedLoad = true;
      throw Error('Could not read files. Try again.');
    }
    return {
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
