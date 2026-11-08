import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, Folder, Search, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { LoadingState } from './LoadingState';
import { SearchableSelect } from './SearchableSelect';
import { FileTypeIcon } from './FileTypeIcon';
import { ExplanationPreferencesFields } from './ExplanationPreferencesFields';
import {
  explanationExclusion,
  type ExplanationFile,
  type ExplanationOptions,
  type ExplanationSetup,
} from '../lib/explanation-options';
import { fileExtension } from '../lib/file-kinds';
import type { GenerateReviewRequest } from '../lib/types';

function FileCheckbox({
  checked,
  mixed,
  label,
  onChange,
}: {
  checked: boolean;
  mixed?: boolean;
  label: string;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!mixed;
  }, [mixed]);
  return <input ref={ref} type="checkbox" checked={checked} aria-label={label} onChange={onChange} />;
}
function FileTree({
  files,
  options,
  onChange,
  query,
}: {
  files: ExplanationFile[];
  options: ExplanationOptions;
  onChange: (options: ExplanationOptions) => void;
  query: string;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const matching = useMemo(
    () => files.filter((file) => file.displayPath.toLowerCase().includes(query.toLowerCase())),
    [files, query]
  );
  const rows = useMemo(() => {
    type Row = { id: string; label: string; depth: number; files: ExplanationFile[]; file?: ExplanationFile };
    const result: Row[] = [];
    const groups = new Map<string, ExplanationFile[]>();
    for (const file of matching) {
      const group = groups.get(file.group) ?? [];
      group.push(file);
      groups.set(file.group, group);
    }
    function walk(groupFiles: ExplanationFile[], group: string, prefix: string, depth: number) {
      const children = new Map<string, ExplanationFile[]>();
      for (const file of groupFiles) {
        const name = file.displayPath.slice(prefix.length).split('/')[0];
        const child = children.get(name) ?? [];
        child.push(file);
        children.set(name, child);
      }
      for (const [name, items] of [...children].sort(([a], [b]) => a.localeCompare(b))) {
        const path = prefix + name,
          folder = items.some((f) => f.displayPath !== path),
          id = JSON.stringify([group, path]);
        result.push({ id, label: name, depth, files: items, file: folder ? undefined : items[0] });
        if (folder && (expanded.has(id) || query)) walk(items, group, path + '/', depth + 1);
      }
    }
    for (const [group, groupFiles] of groups) {
      result.push({ id: group, label: group, depth: 0, files: groupFiles });
      walk(groupFiles, group, '', 1);
    }
    return result;
  }, [matching, expanded, query]);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 34,
    overscan: 10,
  });
  function toggleFiles(items: ExplanationFile[]) {
    const include = items.some((file) => !!explanationExclusion(file, options));
    const overrides = { ...options.fileOverrides };
    for (const file of items) overrides[file.path] = include;
    onChange({ ...options, fileOverrides: overrides });
  }
  return (
    <div ref={scroll} className="explanation-file-tree" role="group" aria-label="Files to include">
      {!rows.length ? (
        <p className="explanation-file-empty">No files match this path.</p>
      ) : (
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => {
            const row = rows[item.index],
              included = row.files.filter((f) => !explanationExclusion(f, options)).length;
            return (
              <div
                className="explanation-file-row"
                key={row.id}
                style={{
                  position: 'absolute',
                  top: item.start,
                  height: item.size,
                  width: '100%',
                  paddingInlineStart: row.depth * 16 + 8,
                }}
              >
                {!row.file && row.depth > 0 ? (
                  <button
                    type="button"
                    className="explanation-folder-toggle"
                    aria-label={`${expanded.has(row.id) ? 'Collapse' : 'Expand'} ${row.label}`}
                    onClick={() =>
                      setExpanded((previous) => {
                        const next = new Set(previous);
                        if (next.has(row.id)) next.delete(row.id);
                        else next.add(row.id);
                        return next;
                      })
                    }
                  >
                    {expanded.has(row.id) || query ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                ) : (
                  <span className="explanation-folder-spacer" />
                )}
                <FileCheckbox
                  checked={included === row.files.length}
                  mixed={included > 0 && included < row.files.length}
                  label={`Include ${row.file?.displayPath ?? row.label}`}
                  onChange={() => toggleFiles(row.files)}
                />
                {row.file ? <FileTypeIcon filePath={row.file.displayPath} /> : <Folder size={14} aria-hidden="true" />}
                <button
                  type="button"
                  className={`explanation-file-name${included ? '' : ' excluded'}`}
                  title={row.file?.displayPath ?? row.label}
                  onClick={() => toggleFiles(row.files)}
                >
                  {row.label}
                </button>
                <span
                  className="explanation-file-reason"
                  title={row.file ? explanationExclusion(row.file, options) : undefined}
                >
                  {row.file
                    ? explanationExclusion(row.file, options)
                      ? options.fileOverrides[row.file.path] === false
                        ? 'Excluded'
                        : options.fileOverrides[row.file.path] === undefined &&
                            options.hiddenExtensions.includes(fileExtension(row.file.displayPath))
                          ? 'Extension'
                          : options.excludeGenerated && row.file.kinds.generated.value
                            ? 'Generated'
                            : 'Test'
                      : options.fileOverrides[row.file.path] === true
                        ? 'Included by you'
                        : ''
                    : `${included}/${row.files.length}`}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ExplanationSetupDialog({
  requests,
  onGenerate,
  onClose,
}: {
  requests: GenerateReviewRequest[];
  onGenerate: (request: GenerateReviewRequest) => Promise<void>;
  onClose: (started: boolean) => void;
}) {
  const [setups, setSetups] = useState<ExplanationSetup[]>([]);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState(0);
  const [remember, setRemember] = useState(false);
  const [useDefaults, setUseDefaults] = useState(requests.length > 1);
  const [common, setCommon] = useState<ExplanationOptions>();
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const started = useRef(new Set<number>());
  const generating = useRef(false);
  const [completed, setCompleted] = useState(0);
  useEffect(() => {
    const lifetime = new AbortController();
    setError('');
    setSetups([]);
    void (async () => {
      const result: ExplanationSetup[] = [];
      // At most two inventories at once; all reads use the existing backend caches.
      for (let i = 0; i < requests.length; i += 2) {
        if (lifetime.signal.aborted) return;
        const batch = await Promise.all(
          requests.slice(i, i + 2).map((request) => window.electronAPI.getExplanationSetup(request))
        );
        result.push(...batch);
      }
      if (!lifetime.signal.aborted) {
        setSetups(result);
        setCommon(result.at(0)?.options);
      }
    })().catch((e: unknown) => {
      if (!lifetime.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      lifetime.abort();
    };
  }, [requests, retry]);
  const setup = setups.at(selected);
  const options = setup
    ? requests.length > 1 && !useDefaults && common
      ? { ...common, fileOverrides: setup.options.fileOverrides }
      : setup.options
    : undefined;
  const extensions = useMemo(
    () =>
      [
        ...new Set([
          ...(setup?.files.map((file) => fileExtension(file.displayPath)) ?? []),
          ...(options?.hiddenExtensions ?? []),
        ]),
      ].sort(),
    [setup, options?.hiddenExtensions]
  );
  const resolvedOptions = (entry: ExplanationSetup) =>
    requests.length > 1 && !useDefaults && common
      ? { ...common, fileOverrides: entry.options.fileOverrides }
      : entry.options;
  function change(value: ExplanationOptions) {
    if (requests.length > 1 && !useDefaults) setCommon(value);
    setSetups((previous) =>
      previous.map((entry, index) =>
        index === selected
          ? {
              ...entry,
              options:
                requests.length > 1 && !useDefaults ? { ...entry.options, fileOverrides: value.fileOverrides } : value,
            }
          : entry
      )
    );
  }
  const invalid = setups.some((entry, index) => {
    if (started.current.has(index)) return false;
    const value = resolvedOptions(entry);
    return (
      (value.style === 'custom' && !value.customInstructions.trim()) ||
      !entry.files.some((file) => !explanationExclusion(file, value))
    );
  });
  async function generate() {
    if (generating.current || invalid || !setups.length) return;
    generating.current = true;
    setBusy(true);
    setError('');
    const failures: string[] = [];
    for (const [index, entry] of setups.entries()) {
      if (started.current.has(index)) continue;
      try {
        await onGenerate({
          ...requests[index],
          explanationOptions: resolvedOptions(entry),
          rememberExplanationOptions: remember,
        });
        started.current.add(index);
        setCompleted(started.current.size);
      } catch (e) {
        failures.push(`${entry.title}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    generating.current = false;
    setBusy(false);
    if (!failures.length) onClose(true);
    else setError(failures.join('\n'));
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose(started.current.size > 0);
      }}
    >
      <DialogContent className="explanation-setup-dialog" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{requests.length > 1 ? 'Generate explanations' : 'Generate explanation'}</DialogTitle>
          <DialogDescription>{setup?.title ?? 'Choose the depth and files for this explanation.'}</DialogDescription>
        </DialogHeader>
        {!setups.length ? (
          error ? (
            <div role="alert">
              <p>{error}</p>
              <Button onClick={() => setRetry((n) => n + 1)}>Retry loading files</Button>
            </div>
          ) : (
            <LoadingState title="Preparing explanation options…" description="Reading the changed-file inventory." />
          )
        ) : (
          <>
            <div className="explanation-setup-body">
              {requests.length > 1 && (
                <div className="explanation-bulk-options">
                  <label>
                    <input
                      type="checkbox"
                      checked={useDefaults}
                      disabled={busy || completed > 0}
                      onChange={(event) => setUseDefaults(event.target.checked)}
                    />
                    Use each repository’s saved settings
                  </label>
                  <SearchableSelect
                    label="Explanation target"
                    value={String(selected)}
                    onValueChange={(value) => {
                      setSelected(Number(value));
                      setQuery('');
                    }}
                    options={setups.map((entry, index) => ({ value: String(index), label: entry.title }))}
                  />
                </div>
              )}
              {setup && options && (
                <fieldset disabled={busy || started.current.has(selected)} className="explanation-setup-fields">
                  {setup.restored && (
                    <p className="explanation-setup-note">
                      Using this explanation’s previous choices. New files follow these filters.
                    </p>
                  )}
                  <fieldset disabled={requests.length > 1 && useDefaults}>
                    <ExplanationPreferencesFields
                      value={options}
                      onChange={(value) => change({ ...value, fileOverrides: options.fileOverrides })}
                    />
                  </fieldset>
                  {requests.length > 1 && !useDefaults && (
                    <p className="explanation-setup-note">
                      Style and filters apply to all selected explanations. File choices apply to the selected PR or
                      stack.
                    </p>
                  )}
                  <button
                    type="button"
                    className="explanation-files-disclosure"
                    aria-expanded={expanded}
                    onClick={() => setExpanded(!expanded)}
                  >
                    {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}Choose files{' '}
                    <span>
                      {setup.files.filter((file) => !explanationExclusion(file, options)).length.toLocaleString()} of{' '}
                      {setup.files.length.toLocaleString()} included
                    </span>
                  </button>
                  {expanded && (
                    <div className="explanation-file-picker">
                      <div className="explanation-file-search">
                        <Search size={15} aria-hidden="true" />
                        <input
                          aria-label="Find explanation files"
                          placeholder="Find a file or folder…"
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                        />
                      </div>
                      <div className="explanation-extension-tags" role="group" aria-label="Hide file extensions">
                        <span>Hide extensions</span>
                        {extensions.map((extension) => (
                          <button
                            type="button"
                            key={extension}
                            aria-pressed={options.hiddenExtensions.includes(extension)}
                            onClick={() =>
                              change({
                                ...options,
                                hiddenExtensions: options.hiddenExtensions.includes(extension)
                                  ? options.hiddenExtensions.filter((e) => e !== extension)
                                  : [...options.hiddenExtensions, extension],
                              })
                            }
                          >
                            {extension || 'No extension'}
                            {options.hiddenExtensions.includes(extension) && <X size={12} aria-hidden="true" />}
                          </button>
                        ))}
                      </div>
                      <div className="explanation-file-actions">
                        <button
                          type="button"
                          onClick={() =>
                            change({
                              ...options,
                              fileOverrides: Object.fromEntries(setup.files.map((file) => [file.path, true])),
                            })
                          }
                        >
                          Include all
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            change({
                              ...options,
                              fileOverrides: Object.fromEntries(setup.files.map((file) => [file.path, false])),
                            })
                          }
                        >
                          Exclude all
                        </button>
                        <button
                          type="button"
                          disabled={!Object.keys(options.fileOverrides).length}
                          onClick={() => change({ ...options, fileOverrides: {} })}
                        >
                          Reset file choices
                        </button>
                      </div>
                      <FileTree key={selected} files={setup.files} options={options} query={query} onChange={change} />
                      <p className="explanation-setup-note">
                        Explicit file choices override filters. Excluded files may still be consulted as supporting
                        context.
                      </p>
                    </div>
                  )}
                  {invalid && (
                    <p role="status" className="explanation-setup-note">
                      Include at least one file per explanation and add instructions for Custom style.
                    </p>
                  )}
                  <label className="explanation-remember">
                    <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
                    Remember for {requests.length > 1 ? 'these repositories' : 'this repository'}
                  </label>
                  {remember && (
                    <p className="explanation-setup-note">
                      Saves the style and filters when generation starts. Individual file choices stay with this
                      explanation.
                    </p>
                  )}
                </fieldset>
              )}
              {error && (
                <p className="explanation-setup-error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="explanation-setup-footer">
              <span>
                {completed > 0
                  ? `${completed} of ${requests.length} started`
                  : setup?.repository.replace(/^local:/, '')}
              </span>
              <Button variant="outline" disabled={busy} onClick={() => onClose(started.current.size > 0)}>
                Cancel
              </Button>
              <Button disabled={busy || invalid} onClick={() => void generate()}>
                {busy
                  ? 'Starting…'
                  : completed
                    ? 'Retry remaining'
                    : requests.length > 1
                      ? `Generate ${requests.length} explanations`
                      : 'Generate explanation'}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
