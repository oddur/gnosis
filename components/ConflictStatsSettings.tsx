import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { mergedUndoRate, STATS_BUCKETS, type ConflictStats, type StatsBucket } from '../lib/conflict-stats';

const BUCKET_NAMES: Record<StatsBucket, string> = { merged: 'Merged', check: 'Check', decide: 'Decide' };

/**
 * Settings › Diagnostics › Conflict resolution stats (#445 item 2): read-only counts of how Resolve conflicts' buckets
 * fare, with Reset. They stay on this computer and inform a later default; nothing here changes one.
 */
export function ConflictStatsSettings() {
  const api = window.electronAPI;
  const [stats, setStats] = useState<ConflictStats>();
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void api.conflictStats?.().then(
      (value) => live && setStats(value),
      () => live && setError('Could not read the conflict resolution stats.')
    );
    return () => {
      live = false;
    };
  }, []);
  if (!api.conflictStats) return null;
  const rate = stats && mergedUndoRate(stats);
  const merged = stats?.buckets.merged;
  return (
    <section className="diagnostics-section" aria-labelledby="conflict-stats-title" data-testid="conflict-stats">
      <h3 id="conflict-stats-title" className="text-sm font-medium">
        Conflict resolution stats
      </h3>
      <p className="settings-description">
        How often you undo or change what Resolve conflicts proposed. Gnosis keeps counts only, on this computer: no
        code, file names, paths or PRs, and nothing is sent anywhere.
      </p>
      {stats && (
        <>
          <p className="settings-description" data-testid="conflict-merged-undo-rate" role="status">
            {rate === undefined || !merged ? (
              'No Merged conflicts yet.'
            ) : (
              <>
                Merged undo rate: <span className="numeric">{Math.round(rate * 1000) / 10}%</span> (
                <span className="numeric">{merged.undone}</span> of <span className="numeric">{merged.shown}</span>{' '}
                Merged conflicts undone).
              </>
            )}
          </p>
          <table className="sync-health-table conflict-stats-table" aria-label="Conflicts by bucket">
            <thead>
              <tr>
                <th scope="col">Bucket</th>
                <th scope="col">Shown</th>
                <th scope="col">Accepted as is</th>
                <th scope="col">Undone</th>
                <th scope="col">Changed to another option</th>
              </tr>
            </thead>
            <tbody>
              {STATS_BUCKETS.map((bucket) => {
                const counts = stats.buckets[bucket];
                return (
                  <tr key={bucket} data-bucket={bucket}>
                    <th scope="row">{BUCKET_NAMES[bucket]}</th>
                    <td className="numeric">{counts.shown}</td>
                    {/* Decide has no proposal to accept. */}
                    <td className="numeric">{bucket === 'decide' ? '—' : counts.accepted}</td>
                    <td className="numeric">{counts.undone}</td>
                    <td className="numeric">{counts.rechosen}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="settings-description" data-testid="conflict-session-stats">
            Sessions: <span className="numeric">{stats.sessions.started}</span> started,{' '}
            <span className="numeric">{stats.sessions.startedOver}</span> started over,{' '}
            <span className="numeric">{stats.sessions.pushed}</span> pushed.
          </p>
        </>
      )}
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={!stats || !api.resetConflictStats}
          onClick={() => {
            setError('');
            void api.resetConflictStats?.().then(setStats, () => setError('Could not reset the stats. Try again.'));
          }}
        >
          Reset
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
    </section>
  );
}
