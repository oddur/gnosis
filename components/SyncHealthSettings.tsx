import { useCallback, useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Toggle, SettingRow } from './SettingsControls';
import { DRIFT_FIELD_LABEL, formatAge, prLabel, type SyncHealthSnapshot } from '../lib/sync-health';
import { useStatusNow } from '../lib/status-clock';

const when = (at: number, now: number) => {
  const ms = Math.max(0, now - at);
  return ms < 60_000 ? 'just now' : `${formatAge(ms)} ago`;
};

function PrLink({ url }: { url: string }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {prLabel(url)}
    </a>
  );
}

/**
 * Settings › Diagnostics › Sync health. The drift detector compares a few PRs with a fresh GitHub read: mismatches are
 * listed here and in the diagnostics export. Plain and dense: this is a tool for reporting problems.
 */
export function SyncHealthSettings() {
  const api = window.electronAPI;
  const supported = !!api.syncHealth;
  const [health, setHealth] = useState<SyncHealthSnapshot | null>(null);
  const [error, setError] = useState('');
  const [exported, setExported] = useState('');
  // Ages render again on the shared status clock.
  useStatusNow();
  const now = Date.now();
  const load = useCallback(() => {
    void api
      .syncHealth?.()
      .then(setHealth)
      .catch(() => setError('Could not read sync health. Reopen Settings to try again.'));
  }, [api]);
  useEffect(() => {
    load();
    const stop = api.onSyncHealthChanged?.(load);
    return typeof stop === 'function' ? stop : undefined;
  }, [api, load]);
  if (!supported) return null;
  const run = health?.runs[0];
  const checking = !!health?.checking;
  const act = (operation: () => Promise<SyncHealthSnapshot> | undefined, failure: string) => {
    setError('');
    void operation()
      ?.then(setHealth)
      .catch(() => setError(failure));
  };
  const summary = !health
    ? 'Loading…'
    : checking
      ? 'Checking PRs against GitHub…'
      : run
        ? `Last check ${when(run.at, now)}: ${run.sampled} PR${run.sampled === 1 ? '' : 's'}, ${run.drift ? `${run.drift} mismatch${run.drift === 1 ? '' : 'es'}` : 'no mismatches'}` +
          `${run.failed ? `, ${run.failed} could not be read` : ''}. Cost ${run.cost} GraphQL point${run.cost === 1 ? '' : 's'}.`
        : 'No checks yet.';
  const next =
    health?.enabled && !checking
      ? health.active
        ? health.nextAt && health.nextAt > now
          ? ` Next background check in about ${formatAge(health.nextAt - now)}.`
          : ' Next background check soon.'
        : ' Background checks wait while Gnosis is hidden, offline or saving its GitHub allowance.'
      : '';
  return (
    <section className="sync-health" aria-labelledby="sync-health-title">
      <h3 id="sync-health-title" className="text-sm font-medium">
        Sync health
      </h3>
      <p className="settings-description">
        Compares what Gnosis shows with a fresh read from GitHub, for up to three PRs you opened recently or have in the
        queue. A difference GitHub made after Gnosis last read the PR counts as a late update, not a mismatch.
      </p>
      <SettingRow
        label="Background checks"
        description="Every 12 minutes while Gnosis is visible. Each PR costs one GraphQL point from the automatic allowance."
      >
        <Toggle
          checked={health?.enabled ?? false}
          ariaLabel="Background sync health checks"
          onChange={() =>
            act(
              () => api.setSyncHealthEnabled?.(!(health?.enabled ?? false)),
              'Could not change background checks. Try again.'
            )
          }
        />
      </SettingRow>
      <div className="sync-health-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={!health || checking}
          onClick={() =>
            act(() => api.checkSyncHealth?.([]), 'Could not check GitHub. Check your connection and try again.')
          }
        >
          {checking ? 'Checking…' : 'Check now'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!api.exportDiagnostics}
          onClick={() => {
            setError('');
            setExported('');
            void api
              .exportDiagnostics?.()
              .then((path) => setExported(path ? `Saved to ${path}` : ''))
              .catch(() => setError('Could not save the diagnostics file. Choose another folder and try again.'));
          }}
        >
          Export diagnostics…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!health || checking || (!health.drifts.length && !health.stale.length && !health.runs.length)}
          onClick={() => act(() => api.clearSyncHealth?.(), 'Could not clear sync health. Try again.')}
        >
          Clear
        </Button>
      </div>
      <p className="settings-description sync-health-summary" role="status">
        {summary}
        {next}
      </p>
      {exported && <p className="settings-description">{exported}</p>}
      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
      <h4 className="sync-health-heading">Mismatches</h4>
      {health?.drifts.length ? (
        <div className="sync-health-scroll">
          <table className="sync-health-table" aria-label="Mismatches between Gnosis and GitHub">
            <thead>
              <tr>
                <th scope="col">PR</th>
                <th scope="col">Field</th>
                <th scope="col">Gnosis</th>
                <th scope="col">GitHub</th>
                <th scope="col">Gnosis read</th>
                <th scope="col">Seen</th>
              </tr>
            </thead>
            <tbody>
              {health.drifts.map((row) => (
                <tr key={`${row.url}|${row.field}|${row.gnosis}|${row.github}`}>
                  <td>
                    <PrLink url={row.url} />
                  </td>
                  <td>{DRIFT_FIELD_LABEL[row.field]}</td>
                  <td>{row.gnosis}</td>
                  <td>{row.github}</td>
                  <td className="numeric" title="How long before GitHub's read Gnosis had read this value">
                    {formatAge(row.ageMs)} earlier
                  </td>
                  <td className="numeric" title={new Date(row.lastSeenAt).toLocaleString()}>
                    {when(row.lastSeenAt, now)}
                    {row.count > 1 ? ` · ${row.count}×` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="settings-description">
          {run ? 'None. Gnosis agreed with GitHub on every PR checked.' : 'None yet.'}
        </p>
      )}
      <h4 className="sync-health-heading">Late updates</h4>
      {health?.stale.length ? (
        <>
          <p className="settings-description">
            GitHub changed these after Gnosis last read them
            {health.unconfirmed
              ? `. ${health.unconfirmed} difference${health.unconfirmed === 1 ? '' : 's'} wait${health.unconfirmed === 1 ? 's' : ''} for a second check`
              : ''}
            .
          </p>
          <ul className="sync-health-stale">
            {health.stale.slice(0, 10).map((row) => (
              <li key={`${row.url}|${row.at}|${row.reason}`}>
                <PrLink url={row.url} /> · {row.fields.map((field) => DRIFT_FIELD_LABEL[field]).join(', ')} ·{' '}
                <span className="numeric">
                  {row.reason === 'unconfirmed' ? 'checking again' : `${formatAge(row.ageMs)} behind`}
                </span>{' '}
                · <span className="numeric">{when(row.at, now)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="settings-description">None.</p>
      )}
    </section>
  );
}
