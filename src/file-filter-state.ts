import { fileOverrideKey, type FileFilterState, type FileKindOverride } from '../lib/file-kinds';
import type { StateStorage } from './app-data-store';
export type FileFilterAction =
  | { filters: { hideGenerated: boolean; hideTests: boolean; hiddenExtensions?: string[] } }
  | { repo: string; path: string; override: FileKindOverride };
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function overrideFrom(value: unknown): FileKindOverride {
  if (!object(value)) return {};
  return {
    ...(typeof value.generated === 'boolean' ? { generated: value.generated } : {}),
    ...(typeof value.test === 'boolean' ? { test: value.test } : {}),
  };
}
function normalizeExtensions(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter(
              (extension): extension is string =>
                typeof extension === 'string' &&
                extension.length <= 256 &&
                (extension === '' || /^\.[^/\\.]+$/.test(extension))
            )
            .map((extension) => extension.toLowerCase())
        ),
      ]
    : [];
}
export function createFileFilterState(storage: StateStorage) {
  const key = 'diff-file-filters:v1';
  return {
    read(): FileFilterState {
      const raw = storage.read(key),
        value = object(raw) ? raw : {};
      return {
        hideGenerated: value.hideGenerated === true,
        hideTests: value.hideTests === true,
        hiddenExtensions: normalizeExtensions(value.hiddenExtensions),
        overrides: Object.fromEntries(
          Object.entries(object(value.overrides) ? value.overrides : {}).map(([k, v]) => [k, overrideFrom(v)])
        ),
      };
    },
    async update(action: FileFilterAction) {
      const current = this.read();
      if ('filters' in action) {
        if (
          !object(action.filters) ||
          typeof action.filters.hideGenerated !== 'boolean' ||
          typeof action.filters.hideTests !== 'boolean'
        )
          throw Error('Invalid file filters');
        if (action.filters.hiddenExtensions !== undefined) {
          if (
            !Array.isArray(action.filters.hiddenExtensions) ||
            action.filters.hiddenExtensions.length > 1000 ||
            action.filters.hiddenExtensions.some(
              (extension: unknown) =>
                typeof extension !== 'string' ||
                extension.length > 256 ||
                (extension !== '' && !/^\.[^/\\.]+$/.test(extension))
            )
          )
            throw Error('Invalid file extensions');
          current.hiddenExtensions = normalizeExtensions(action.filters.hiddenExtensions);
        }
        current.hideGenerated = action.filters.hideGenerated;
        current.hideTests = action.filters.hideTests;
      } else {
        if (
          !/^[\w.-]+\/[\w.-]+$/.test(action.repo) ||
          typeof action.path !== 'string' ||
          !action.path ||
          action.path.length > 4096
        )
          throw Error('Invalid repository or file path');
        if (!object(action.override)) throw Error('Invalid file classification');
        for (const kind of ['generated', 'test'] as const) {
          const v = action.override[kind];
          if (v !== undefined && typeof v !== 'boolean') throw Error('Invalid file classification');
        }
        const override = overrideFrom(action.override),
          id = fileOverrideKey(action.repo, action.path);
        if (Object.keys(override).length) current.overrides[id] = override;
        else current.overrides = Object.fromEntries(Object.entries(current.overrides).filter(([k]) => k !== id));
      }
      storage.write(key, current);
      await storage.flush();
      return current;
    },
  };
}
