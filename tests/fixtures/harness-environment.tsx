import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HarnessEnvironmentSettings } from '../../components/HarnessEnvironmentSettings';
import { emptyHarnessEnvironment, type EnvironmentVariable } from '../../lib/harness-environment';
import type { Provider } from '../../lib/models';
import '../../src/globals.css';
const fixture = { saved: emptyHarnessEnvironment(), failLoad: false, failSave: false };
Object.assign(window, {
  environmentFixture: fixture,
  electronAPI: {
    loadHarnessEnvironment: () => {
      if (fixture.failLoad) return Promise.reject(Error('locked'));
      return Promise.resolve(structuredClone(fixture.saved));
    },
    saveHarnessEnvironment: (provider: Provider, variables: EnvironmentVariable[]) => {
      if (fixture.failSave) return Promise.reject(Error('locked'));
      fixture.saved[provider] = structuredClone(variables);
      return Promise.resolve();
    },
  },
});
function Fixture() {
  const [open, setOpen] = useState(true);
  return (
    <main className="mx-auto max-w-xl p-6">
      <button className="mb-6" onClick={() => setOpen(!open)}>
        Toggle settings
      </button>
      {open && <HarnessEnvironmentSettings />}
    </main>
  );
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<Fixture />);
