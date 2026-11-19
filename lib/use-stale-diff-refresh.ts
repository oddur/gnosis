import { useSyncExternalStore } from 'react';
import { addDiagnosticsSource } from './diagnostics-sources';
import { dropInspectionFile, inspectionData, inspectionFiles } from './inspection-cache';
import { createStaleDiffRefresh, type StaleAttempt } from './stale-diff-refresh';

/**
 * The app's stale-diff recovery (lib/stale-diff-refresh.ts). Without a Changes view of the PR (an Explanation topic),
 * the PR's changes refresh through the inspection cache at the view tier; Changes registers its own refresh, which is
 * its Update changes.
 */
export const staleDiffRefresh = createStaleDiffRefresh({
  refresh: async (url, revision, paths, interactive) => {
    const snapshot = await inspectionData.readChanges({ url, ...revision }, true, interactive ? false : 'view', undefined, {
      ...revision,
      paths,
    });
    return snapshot.metadata;
  },
  drop: dropInspectionFile,
  reread: (request, both, interactive) =>
    both
      ? inspectionFiles.read(request, interactive ? false : 'view')
      : inspectionFiles.readAfter(request, interactive ? false : 'view'),
});
// Files that still did not match their patch after a refresh: PR, path, head, the first line that differs, and how
// the two end their lines.
addDiagnosticsSource('staleDiffs', () => staleDiffRefresh.stats());

const subscribe = (listener: () => void) => staleDiffRefresh.subscribe(listener);
/** The file's automatic attempt, as it changes. */
export function useStaleAttempt(key: string | undefined): StaleAttempt | undefined {
  return useSyncExternalStore(subscribe, () => (key ? staleDiffRefresh.attempt(key) : undefined));
}
