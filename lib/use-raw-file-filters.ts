import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { PrChanges, PrChangeFile } from './pr-changes';
import { inspectionFileRequest } from './inspection-cache';
import {
  classificationKey,
  DEFAULT_FILE_FILTERS,
  effectiveFileKinds,
  fileOverrideKey,
  fileSource,
  pathFileKinds,
  type FileKinds,
  type FileFilterState,
} from './file-kinds';
import type { FileFilterAction } from '../src/file-filter-state';
const listeners = new Set<() => void>();
const classifications = new Map<string, Record<string, FileKinds>>();
let version = 0;
let state: FileFilterState = DEFAULT_FILE_FILTERS;
let busy = false,
  error = '',
  lastAction: FileFilterAction | undefined;
const emit = () => {
  version++;
  listeners.forEach((f) => f());
};
function receive(key: string, kinds: Record<string, FileKinds>) {
  if (JSON.stringify(classifications.get(key)) === JSON.stringify(kinds)) return;
  classifications.set(key, kinds);
  while (classifications.size > 150) {
    const oldest = classifications.keys().next().value;
    if (oldest === undefined) break;
    classifications.delete(oldest);
  }
  emit();
}
export function useFileFilterSync() {
  useEffect(() => {
    let live = true;
    void load(() => live);
    const stopState = window.electronAPI.onFileFiltersChanged((value) => {
      state = value;
      emit();
    });
    const stopKinds = window.electronAPI.onFileClassificationsChanged(receive);
    return () => {
      live = false;
      if (typeof stopState === 'function') stopState();
      if (typeof stopKinds === 'function') stopKinds();
    };
  }, []);
}
async function load(live = () => true) {
  try {
    const value = await window.electronAPI.loadFileFilters();
    if (live()) {
      state = value;
      error = '';
      emit();
    }
  } catch {
    if (live()) {
      error = 'Could not load file filters.';
      emit();
    }
  }
}
async function update(action: FileFilterAction) {
  if (busy) return;
  busy = true;
  error = '';
  lastAction = action;
  emit();
  try {
    state = await window.electronAPI.updateFileFilters(action);
    lastAction = undefined;
  } catch (e) {
    error = e instanceof Error ? e.message : 'Could not save file filters.';
  } finally {
    busy = false;
    emit();
  }
}
export function useRawFileFilters(snapshots: PrChanges[]) {
  useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    () => version
  );
  const key = snapshots.map(classificationKey).join('|');
  const latest = useMemo(
    () =>
      Object.fromEntries(
        snapshots.map((s) => [
          classificationKey(s),
          {
            ...Object.fromEntries(s.files.map((f) => [f.path, pathFileKinds(f.path)])),
            ...s.fileKinds,
            ...classifications.get(classificationKey(s)),
          },
        ])
      ),
    [snapshots, key, version]
  );
  const [frozen, setFrozen] = useState({ key, kinds: latest });
  if (frozen.key !== key) setFrozen({ key, kinds: latest });
  const active = frozen.key === key ? frozen.kinds : latest;
  useEffect(() => {
    let live = true;
    for (const s of snapshots) {
      const f = s.files.at(0);
      if (!f) continue;
      void window.electronAPI
        .getFileClassifications(inspectionFileRequest(s, f))
        .then((value) => {
          if (live) receive(classificationKey(s), value);
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [key]);
  const kind = (s: PrChanges, f: PrChangeFile) =>
    effectiveFileKinds(
      (active as Partial<Record<string, Partial<Record<string, FileKinds>>>>)[classificationKey(s)]?.[f.path] ??
        pathFileKinds(f.path),
      state.overrides[fileOverrideKey(s.metadata.baseRepo ?? fileSource(s, f).repo, f.path)]
    );
  return {
    state,
    busy,
    error,
    kind,
    update,
    retry: () => (lastAction ? update(lastAction) : load()),
    pending: JSON.stringify(latest) !== JSON.stringify(active),
    apply: () => setFrozen({ key, kinds: latest }),
  };
}
