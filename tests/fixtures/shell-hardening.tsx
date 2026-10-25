import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActivityDrawer } from '../../components/ActivityDrawer';
import { GlobalCommandPalette } from '../../components/GlobalCommandPalette';
import { Toaster } from '../../components/ui/toast';
import type { ActivityTask } from '../../lib/activity';
import '../../src/globals.css';

const tasks: ActivityTask[] = ['first', 'second'].map((id) => ({
  id,
  kind: 'review',
  title: `${id} — Keep retry boundaries explicit 日本語 🧪 ${'long-file-name'.repeat(12)}`,
  detail: 'Generation interrupted. Retry to continue.',
  status: 'failed',
  canRetry: true,
  canCancel: false,
  updatedAt: '2026-10-25T00:00:00Z',
  reviewId: id,
}));
const mocks = {
  listActivity: () => Promise.resolve(structuredClone(tasks)),
  activityAction: () => Promise.resolve(),
  commandSearch: () => Promise.resolve({ account: 'fixture', hits: [], total: 0, ignoreBots: true, warnings: [] }),
  commandGitHubSearch: () => Promise.resolve([]),
};
Object.defineProperty(window, 'electronAPI', { value: mocks });
function Fixture() {
  const [activity, setActivity] = useState(true),
    [commands, setCommands] = useState(false);
  return (
    <>
      <main style={{ padding: 24 }}>
        <h1>Review queue</h1>
        <button onClick={() => setCommands(true)}>Open commands</button>
      </main>
      <ActivityDrawer open={activity} onOpenChange={setActivity} onOpen={() => Promise.resolve()} />
      <GlobalCommandPalette
        open={commands}
        onClose={() => setCommands(false)}
        navigate={() => Promise.resolve()}
        commands={[
          {
            id: 'slow-action',
            label: 'Run slow action',
            perform: () => window.electronAPI.activityAction('command', 'retry'),
          },
        ]}
      />
      <Toaster />
    </>
  );
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<Fixture />);
