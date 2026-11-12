import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { LoadingState, LoadingIndicator } from '../../components/LoadingState';
import { WorkflowGraphState } from '../../components/WorkflowGraphState';
import { LoadingScreen } from '../../components/LoadingScreen';
import { Button } from '../../components/ui/button';
import { ExplanationBuild } from '../../components/ExplanationBuild';
import { explanationSteps, initialExplanationProgress, reduceExplanationProgress, type ExplanationEvent } from '../../lib/explanation-progress';
import type { ActivityTask } from '../../lib/activity';

const events: ExplanationEvent[] = [
  { type: 'context', files: 48, imports: 12 },
  { type: 'phase', phase: 'Planning review structure' },
  { type: 'plan', topics: [{ id: 'slide-1', title: 'Retry scheduling moves to the consumer' }, { id: 'slide-2', title: 'Backoff configuration' }, { id: 'slide-3', title: 'Tests' }] },
  { type: 'phase', phase: 'Writing topics', completed: 1, total: 3 },
  { type: 'topic', id: 'slide-1', status: 'done' },
  { type: 'topic', id: 'slide-2', status: 'writing' },
];
const build: ActivityTask = {
  id: 'review:fixture',
  kind: 'review',
  title: 'Fix reconnect',
  detail: 'Writing topics',
  status: 'running',
  steps: explanationSteps(events.reduce(reduceExplanationProgress, initialExplanationProgress())),
  startedAt: new Date(Date.now() - 102_000).toISOString(),
  updatedAt: new Date().toISOString(),
  canCancel: true,
  canRetry: false,
};
import '../../src/globals.css';
function Fixture() {
  const [waiting, setWaiting] = useState(true);
  return (
    <main className="loading-fixture" style={{ padding: 24, maxWidth: 1100, margin: 'auto' }}>
      <style>{`.loading-fixture-grid { display:grid;grid-template-columns:1fr 1fr;gap:24px; } .loading-fixture section {min-width:0;border:1px solid var(--border);border-radius:8px;} .loading-fixture h2 {padding:12px 16px;border-bottom:1px solid var(--border);font-size:14px;font-weight:600;} @media(max-width:700px){.loading-fixture-grid{grid-template-columns:1fr;}}`}</style>
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold">Loading feedback</h1>
        <Button onClick={() => setWaiting((v) => !v)}>Toggle result</Button>
      </header>
      <div className="loading-fixture-grid">
        <section>
          <h2>Changes</h2>
          {waiting ? (
            <LoadingState title="Loading changed files…" hint="You can keep browsing." />
          ) : (
            <p className="p-6">Changes are ready.</p>
          )}
        </section>
        <section>
          <h2>Workflow graph</h2>
          <div style={{ position: 'relative', height: 270 }}>
            <WorkflowGraphState loading={waiting} readingRuns={false} failed={false} />
          </div>
        </section>
        <section>
          <h2>File contents</h2>
          <LoadingState compact title="Loading file contents…" />
          <LoadingState
            compact
            title="Loading a file with a particularly long translated name that should wrap without displacing its status indicator…"
          />
        </section>
        <section>
          <h2>Refresh with content available</h2>
          <div className="p-4 grid gap-4">
            <p>3 GitHub threads · 1 unresolved</p>
            <LoadingIndicator>Refreshing comments…</LoadingIndicator>
            <Button disabled>
              <LoadingIndicator>Requesting reruns… 2/4</LoadingIndicator>
            </Button>
          </div>
        </section>
        <section style={{ gridColumn: '1 / -1', padding: 16 }}>
          <ExplanationBuild task={build} subject="#150 Fix reconnect" actions={{ onRead: () => {} }} />
        </section>
      </div>
      <div id="offscreen" style={{ marginTop: '100vh' }}>
        <LoadingState title="Loading older files…" />
      </div>
      <LoadingScreen message="Waiting for the selected coding agent." />
    </main>
  );
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<Fixture />);
