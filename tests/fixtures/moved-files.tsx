import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { PrFileInspection } from '../../components/PrFileInspection';
import type { Preferences } from '../../lib/types';
import type { PrChanges } from '../../lib/pr-changes';
import type { GitHubReviewThread } from '../../lib/review-threads';

export function mountMovedFiles(preferences: Preferences, snapshot: PrChanges) {
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;inset:0;z-index:9999;overflow:auto;background:var(--background);color:var(--foreground)';
  document.body.append(host);
  function Fixture() {
    const [mode, setMode] = useState('Changes');
    const [path, setPath] = useState('src/moved.ts');
    const [next, setNext] = useState(false);
    const [sourceLine, setSourceLine] = useState<number>();
    const file = snapshot.files.find((f) => f.path === path) ?? snapshot.files[0];
    const current =
      mode === 'Combined'
        ? {
            ...snapshot,
            stackComparison: {
              key: 'a'.repeat(64),
              subjectId: 'moves',
              members: [{ metadata: snapshot.metadata, comparisonBase: snapshot.comparisonBase }],
              fileSources: Object.fromEntries(snapshot.files.map((f) => [f.path, [snapshot.url]])),
            },
          }
        : snapshot;
    const thread = {
      id: 'move-thread',
      path: file.path,
      line: 1,
      startLine: null,
      diffSide: 'RIGHT',
      isResolved: false,
      isOutdated: false,
      viewerCanResolve: false,
      viewerCanUnresolve: false,
      comments: [
        {
          id: 'move-comment',
          body: 'Please keep this public import path compatible.',
          createdAt: '2026-10-29T12:00:00Z',
          url: snapshot.url,
          author: { login: 'reviewer', avatarUrl: '' },
        },
      ],
    } as GitHubReviewThread;
    return (
      <main>
        <nav className="changes-toolbar" aria-label="Fixture view">
          {['Changes', 'Commits', 'Combined'].map((label) => (
            <button
              key={label}
              onClick={() => {
                setMode(label);
                setSourceLine(undefined);
              }}
            >
              {label}
            </button>
          ))}
          {snapshot.files.map((f) => (
            <button
              key={f.path}
              onClick={() => {
                setPath(f.path);
                setSourceLine(undefined);
              }}
            >
              {f.path}
            </button>
          ))}
          <button onClick={() => setSourceLine(2)}>Jump to line</button>
        </nav>
        {next && <p>Next file requested</p>}
        <PrFileInspection
          key={`${mode}:${path}`}
          entry={{ key: file.path, snapshot: current, file }}
          preferences={preferences}
          discussion={{
            discussions: {
              [snapshot.url]: {
                data: {
                  headSha: snapshot.metadata.headSha,
                  baseSha: snapshot.metadata.baseSha,
                  threads: mode === 'Commits' ? [] : [thread],
                },
              },
            },
            refresh: async () => {},
            replace: () => {},
          }}
          onAsk={() => {}}
          onViewedNext={() => setNext(true)}
          sourceLine={sourceLine}
          onOpenCurrentFile={mode === 'Commits' ? () => {} : undefined}
          onOpenSource={() => {}}
        />
      </main>
    );
  }
  createRoot(host).render(<Fixture />);
}
