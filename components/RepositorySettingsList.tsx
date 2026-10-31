import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { Button } from './ui/button';
import { RepositoryMark } from './RepositoryAppearance';
import { RepositorySettingsEditor } from './RepositorySettingsEditor';
import {
  repositoryKey,
  normalizeRepositorySettings,
  type RepositoryDefaults,
  type RepositorySettingsMap,
  type RepositorySettings,
  type BriefingBudget,
} from '../lib/repository-settings';
export function RepositorySettingsList({
  repositories,
  settings,
  defaults,
  onChange,
  onRemove,
  budget,
  focused = false,
}: {
  focused?: boolean;
  repositories: string[];
  settings: RepositorySettingsMap;
  defaults: RepositoryDefaults;
  onChange: (settings: RepositorySettingsMap) => void;
  onRemove?: (repo: string) => void;
  budget?: BriefingBudget;
}) {
  const [expanded, setExpanded] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const scroll = useRef(0);
  const returnTo = useRef('');
  const drafts = useRef(new Map<string, { value: RepositorySettings; changed: (keyof RepositorySettings)[] }>());
  const matching = repositories.filter((repo) => repo.toLowerCase().includes(query.trim().toLowerCase()));
  function openEditor(repo: string) {
    scroll.current = root.current?.querySelector('.repository-list-rows')?.scrollTop ?? 0;
    returnTo.current = repo;
    setExpanded(repo);
  }
  useLayoutEffect(() => {
    if (!focused) return;
    if (expanded) root.current?.querySelector<HTMLHeadingElement>('.repository-editor-heading h3')?.focus();
    else {
      const list = root.current?.querySelector('.repository-list-rows');
      if (list) list.scrollTop = scroll.current;
      const label = returnTo.current === 'bulk' ? 'Configure selected repositories' : `Configure ${returnTo.current}`;
      const target = [...(root.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (button) => button.getAttribute('aria-label') === label
      );
      target?.focus({ preventScroll: true });
    }
  }, [expanded, focused]);

  const active = selected.filter((repo) => repositories.includes(repo));
  const selectable = focused ? matching : repositories;
  function apply(value: RepositorySettings, keys: (keyof RepositorySettings)[]) {
    const next = { ...settings };
    for (const repo of expanded === 'bulk' ? active : [expanded]) {
      const key = repositoryKey(repo);
      next[key] = expanded === 'bulk' ? { ...next[key], ...Object.fromEntries(keys.map((k) => [k, value[k]])) } : value;
    }
    onChange(normalizeRepositorySettings(next));
    drafts.current.delete(expanded);
    setExpanded('');
  }
  const editor = (bulk: boolean) => (
    <RepositorySettingsEditor
      key={expanded}
      repo={bulk ? `${active.length} repositories` : expanded}
      value={drafts.current.get(expanded)?.value ?? (bulk ? {} : (settings[repositoryKey(expanded)] ?? {}))}
      initialChanged={drafts.current.get(expanded)?.changed}
      onDraftChange={(value, changed) => {
        drafts.current.set(expanded, { value, changed });
      }}
      defaults={defaults}
      budget={budget}
      bulk={bulk}
      onApply={apply}
      onCancel={() => {
        drafts.current.delete(expanded);
        setExpanded('');
      }}
      action={bulk ? 'Apply to selected repositories' : 'Save settings'}
    />
  );
  return (
    <div ref={root} className={`repository-settings-list ${focused ? 'repository-list-focused' : ''}`}>
      {focused && expanded ? (
        <div className="repository-settings-focus">
          <Button type="button" variant="ghost" size="sm" className="repository-back" onClick={() => setExpanded('')}>
            <ArrowLeft size={14} /> Back to repositories
          </Button>
          {editor(expanded === 'bulk')}
        </div>
      ) : (
        <>
          {focused && (
            <div className="repository-list-search">
              <label>
                <Search size={15} aria-hidden="true" />
                <input
                  aria-label="Filter watched repositories"
                  placeholder="Filter repositories…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <span>{query ? `${matching.length} of ${repositories.length}` : repositories.length} repositories</span>
            </div>
          )}
          {repositories.length > 1 && (
            <div className="repository-bulk-actions">
              <label>
                <input
                  aria-label="Select all repositories"
                  type="checkbox"
                  checked={selectable.length > 0 && selectable.every((repo) => active.includes(repo))}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...new Set([...active, ...selectable])]
                        : active.filter((repo) => !selectable.includes(repo))
                    )
                  }
                />{' '}
                {focused && query ? 'Select matching' : 'Select all'}
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!active.length}
                aria-label="Configure selected repositories"
                onClick={() => openEditor('bulk')}
              >
                Configure selected{active.length ? ` (${active.length})` : ''}
              </Button>
            </div>
          )}
          {expanded === 'bulk' && (
            <RepositorySettingsEditor
              key="bulk"
              repo={`${active.length} repositories`}
              value={{}}
              defaults={defaults}
              bulk
              onApply={apply}
              onCancel={() => setExpanded('')}
              action="Apply to selected repositories"
            />
          )}
          <div className="repository-list-rows">
            {focused && !matching.length && (
              <p className="repository-list-empty">
                {repositories.length
                  ? 'No repositories match your filter.'
                  : 'No watched repositories. Add a repository to include its PRs in your queue.'}
              </p>
            )}
            {(focused ? matching : repositories).map((repo) => {
              const value = settings[repositoryKey(repo)] ?? {};
              return (
                <div className="repository-settings-entry" key={repo}>
                  <div className="repository-settings-row">
                    <input
                      type="checkbox"
                      aria-label={`Select ${repo}`}
                      checked={active.includes(repo)}
                      onChange={(e) =>
                        setSelected(e.target.checked ? [...active, repo] : active.filter((r) => r !== repo))
                      }
                    />
                    <button
                      type="button"
                      className="repository-settings-expand"
                      aria-expanded={focused ? undefined : expanded === repo}
                      aria-label={`Configure ${repo}`}
                      onClick={() => (expanded === repo ? setExpanded('') : openEditor(repo))}
                    >
                      {expanded === repo ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      <RepositoryMark repo={repo} settings={value} />
                      <span className="repository-settings-summary">
                        {drafts.current.has(repo)
                          ? 'Unsaved changes'
                          : Object.keys(value).length
                            ? 'Customized'
                            : 'Global defaults'}
                      </span>
                    </button>
                    {onRemove && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Stop watching ${repo}`}
                        onClick={() => onRemove(repo)}
                      >
                        Unwatch
                      </Button>
                    )}
                  </div>
                  {expanded === repo && (
                    <>
                      <RepositorySettingsEditor
                        key={repo}
                        repo={repo}
                        value={value}
                        defaults={defaults}
                        budget={budget}
                        onApply={apply}
                        onCancel={() => setExpanded('')}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
