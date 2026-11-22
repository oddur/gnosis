import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Toggle, SettingRow } from './SettingsControls';
import { SyncHealthSettings } from './SyncHealthSettings';
import { ConflictStatsSettings } from './ConflictStatsSettings';
import { interactionMonitorState, onSlowInteraction, setSlowInteractionLog, slowInteractions } from '../lib/interaction-latency';
import { collectRendererDiagnostics } from '../lib/diagnostics';

/** Settings › Diagnostics › Slow interactions (#345): the count this window recorded and an optional console log. */
function SlowInteractionsSettings() {
  const [count, setCount] = useState(() => slowInteractions().length);
  const [logging, setLogging] = useState(() => interactionMonitorState().log);
  useEffect(() => onSlowInteraction(() => setCount(slowInteractions().length)), []);
  const threshold = interactionMonitorState().threshold;
  return (
    <section className="diagnostics-section" aria-labelledby="slow-interactions-title">
      <h3 id="slow-interactions-title" className="text-sm font-medium">
        Slow interactions
      </h3>
      <p className="settings-description">
        A click or key press that took more than {threshold} ms to show its result. Gnosis keeps the last 200 in this
        window, with what was pressed and where the time went. Text, titles and file names are never recorded.
      </p>
      <p className="settings-description" data-testid="slow-interaction-count" role="status">
        <span className="numeric">{count}</span> recorded in this window.
      </p>
      <SettingRow label="Log slow interactions" description="Print each one to the developer console as it happens.">
        <Toggle
          checked={logging}
          ariaLabel="Log slow interactions"
          onChange={() => {
            setSlowInteractionLog(!logging);
            setLogging(!logging);
          }}
        />
      </SettingRow>
    </section>
  );
}

/** Settings › Diagnostics: one export for sync health, slow interactions, and app, system and startup details. */
export function DiagnosticsSettings() {
  const api = window.electronAPI;
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function exportDiagnostics() {
    setSaved('');
    setError('');
    setSaving(true);
    try {
      const path = await api.exportDiagnostics?.(await collectRendererDiagnostics());
      if (path) setSaved(`Saved to ${path}`);
    } catch {
      setError('Could not save the diagnostics file. Choose another folder and try again.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="diagnostics-settings">
      <section className="diagnostics-section" aria-labelledby="diagnostics-export-title">
        <h3 id="diagnostics-export-title" className="text-sm font-medium">
          Export
        </h3>
        <p className="settings-description">
          One JSON file with the app version, system and startup details, sync health and slow interactions. It stays
          on this computer until you share it.
        </p>
        <div>
          <Button size="sm" variant="outline" disabled={!api.exportDiagnostics || saving} onClick={() => void exportDiagnostics()}>
            {saving ? 'Saving…' : 'Export diagnostics…'}
          </Button>
        </div>
        {saved && (
          <p className="settings-description diagnostics-saved" role="status">
            {saved}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {error}
          </p>
        )}
      </section>
      <SyncHealthSettings />
      <SlowInteractionsSettings />
      <ConflictStatsSettings />
    </div>
  );
}
