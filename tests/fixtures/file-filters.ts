import {
  DEFAULT_FILE_FILTERS,
  classificationKey,
  fileOverrideKey,
  pathFileKinds,
  type FileKinds,
  type FileFilterState,
} from '../../lib/file-kinds';
import type { FileFilterAction } from '../../src/file-filter-state';
import type { PrChanges, PrChangeFile } from '../../lib/pr-changes';
const stateKey = 'fixture-file-filters';
let state = (JSON.parse(sessionStorage.getItem(stateKey) ?? 'null') as FileFilterState | null) ?? {
  ...DEFAULT_FILE_FILTERS,
};
const subscribers = new Set<(key: string, kinds: Record<string, FileKinds>) => void>();
const paths = [
  'src/worker.ts',
  'src/other.ts',
  'package-lock.json',
  'tests/worker.test.ts',
  'tests/__snapshots__/worker.snap',
];
export function filterFixtureFiles(url: string): PrChangeFile[] {
  return (
    url.endsWith('/120')
      ? ['package-lock.json']
      : [...paths, ...(new URLSearchParams(location.search).has('extension-files') ? ['README', '.gitignore'] : [])]
  ).map((path) => ({
    path,
    status: 'modified',
    additions: 1,
    deletions: 1,
    changeId: path,
    patch: '@@ -1 +1 @@\n-old\n+new',
  }));
}
export const fileFilterMocks = {
  loadFileFilters: () => Promise.resolve(state),
  updateFileFilters: (action: FileFilterAction) => {
    if (sessionStorage.getItem('fixture-fail-file-filters'))
      return Promise.reject(Error('Could not save file filters.'));
    if ('filters' in action) state = { ...state, ...action.filters };
    else {
      state = {
        ...state,
        overrides: { ...state.overrides, [fileOverrideKey(action.repo, action.path)]: action.override },
      };
    }
    sessionStorage.setItem(stateKey, JSON.stringify(state));
    return Promise.resolve(state);
  },
  onFileFiltersChanged: () => () => {},
  onFileClassificationsChanged: (fn: (key: string, kinds: Record<string, FileKinds>) => void) => {
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  },
  getFileClassifications: () => Promise.resolve({}),
};
window.addEventListener('fixture-file-classifications', (e) => {
  const snapshot = (e as CustomEvent<PrChanges>).detail;
  const kinds = Object.fromEntries(
    snapshot.files.map((f) => [
      f.path,
      { ...pathFileKinds(f.path), generated: { value: true, reason: '.gitattributes: * linguist-generated' } },
    ])
  );
  for (const fn of subscribers) fn(classificationKey(snapshot), kinds);
});
