import { useId } from 'react';
import { FileExtensionFilter } from './FileExtensionFilter';
import { Popover } from 'radix-ui';
import { ListFilter } from 'lucide-react';
import { Button } from './ui/button';
import { EntryActions } from './EntryActions';
import { fileOverrideKey, fileSource, type FileKinds } from '../lib/file-kinds';
import type { PrChanges, PrChangeFile } from '../lib/pr-changes';
import type { useRawFileFilters } from '../lib/use-raw-file-filters';
export type RawFilters = ReturnType<typeof useRawFileFilters>;
export function RawFileFilters({
  filters,
  generated,
  tests,
  hidden,
  paths,
}: {
  filters: RawFilters;
  generated: number;
  tests: number;
  hidden: number;
  paths: string[];
}) {
  const { state, busy } = filters;
  const countId = useId();
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button size="sm" variant="ghost" aria-label="Filter files" aria-describedby={hidden ? countId : undefined}>
          <ListFilter size={15} /> Files
          {hidden > 0 && (
            <span id={countId} className="file-filter-count">
              {hidden} hidden
            </span>
          )}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="raw-file-filter-popover"
          aria-label="File filters"
          data-combobox-container="inside"
        >
          <strong>Hide files</strong>
          <label>
            <input
              type="checkbox"
              checked={state.hideGenerated}
              disabled={busy}
              onChange={(e) =>
                void filters.update({ filters: { hideGenerated: e.target.checked, hideTests: state.hideTests } })
              }
            />{' '}
            Generated files <span>{generated}</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={state.hideTests}
              disabled={busy}
              onChange={(e) =>
                void filters.update({ filters: { hideGenerated: state.hideGenerated, hideTests: e.target.checked } })
              }
            />{' '}
            Test files <span>{tests}</span>
          </label>
          <FileExtensionFilter
            paths={paths}
            value={state.hiddenExtensions}
            disabled={busy}
            onChange={(extensions) =>
              void filters.update({
                filters: {
                  hideGenerated: state.hideGenerated,
                  hideTests: state.hideTests,
                  hiddenExtensions: extensions,
                },
              })
            }
          />
          <p>Applies to Changes and Commits. Hidden files still count toward review progress.</p>
          {(state.hideGenerated || state.hideTests || state.hiddenExtensions.length > 0) && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void filters.update({ filters: { hideGenerated: false, hideTests: false, hiddenExtensions: [] } })
              }
            >
              Show hidden files
            </Button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
export function FileKindControl({
  snapshot,
  file,
  kinds,
  filters,
}: {
  snapshot: PrChanges;
  file: PrChangeFile;
  kinds: FileKinds;
  filters: RawFilters;
}) {
  const repo = snapshot.metadata.baseRepo ?? fileSource(snapshot, file).repo;
  const override = filters.state.overrides[fileOverrideKey(repo, file.path)] ?? {};
  return (
    <div className="file-kind-control">
      {kinds.generated.value && (
        <span className="file-kind-tag" title={kinds.generated.reason}>
          Generated
        </span>
      )}
      {kinds.test.value && (
        <span className="file-kind-tag" title={kinds.test.reason}>
          Test
        </span>
      )}
      <EntryActions
        label={`File classification for ${file.path}`}
        description={
          <div className="file-kind-reasons">
            <p>
              <strong>Generated: {kinds.generated.value ? 'yes' : 'no'}</strong>
              <span>{kinds.generated.reason}</span>
            </p>
            <p>
              <strong>Test: {kinds.test.value ? 'yes' : 'no'}</strong>
              <span>{kinds.test.reason}</span>
            </p>
          </div>
        }
        groups={[
          (['generated', 'test'] as const).map((kind) => ({
            label: `Treat as ${kinds[kind].value ? 'not ' : ''}${kind === 'test' ? 'a test file' : 'generated'}`,
            disabled: filters.busy,
            run: () => filters.update({ repo, path: file.path, override: { ...override, [kind]: !kinds[kind].value } }),
          })),
          [
            {
              label: 'Use automatic classification',
              disabled: filters.busy || !Object.keys(override).length,
              run: () => filters.update({ repo, path: file.path, override: {} }),
            },
          ],
        ]}
      />
    </div>
  );
}
