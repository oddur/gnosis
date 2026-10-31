import { RepositoryMark } from './RepositoryAppearance';
import { useRepositorySettings } from '../lib/use-repository-settings';
import { repositoryKey } from '../lib/repository-settings';
import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  findComboboxContainer,
} from './ui/combobox';
import type { RepoSearchResult } from '../lib/types';
export function RepositoryPicker({
  value,
  onChange,
  options,
  search = false,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  options?: string[];
  search?: boolean;
}) {
  const { settings } = useRepositorySettings();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RepoSearchResult[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!search || query.trim().length < 2) {
      setState('idle');
      return;
    }
    let active = true;
    setState('loading');
    const timer = setTimeout(() => {
      window.electronAPI
        .searchRepos(query.trim())
        .then((rows) => {
          if (active) {
            setResults(rows);
            setState('idle');
          }
        })
        .catch(() => {
          if (active) setState('error');
        });
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [search, query, retry]);
  const items = useMemo(
    () =>
      [
        ...new Set([
          ...value,
          ...(options ?? []),
          ...results.map((r) => r.fullName),
          ...(search && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(query.trim()) ? [query.trim()] : []),
        ]),
      ].sort((a, b) => a.localeCompare(b)),
    [value, options, results, query, search]
  );
  return (
    <div className="setup-repositories">
      <Combobox
        multiple
        items={items}
        value={value}
        onValueChange={onChange}
        inputValue={query}
        onInputValueChange={(next, details) => {
          if (details.reason !== 'item-press') setQuery(next);
        }}
        open={open}
        onOpenChange={(next) => {
          setContainer(findComboboxContainer(trigger.current));
          setOpen(next);
          if (!next) setQuery('');
        }}
        autoHighlight
      >
        <ComboboxTrigger ref={trigger} aria-label="Choose repositories">
          {value.length
            ? `${value.length} ${value.length === 1 ? 'repository' : 'repositories'} selected`
            : 'Choose repositories'}
        </ComboboxTrigger>
        <ComboboxContent container={container}>
          <ComboboxInput
            aria-label="Search repositories"
            placeholder={search ? 'Search or enter owner/repository…' : 'Search repositories…'}
          />
          <ComboboxEmpty>
            {state === 'loading'
              ? 'Searching GitHub…'
              : query.length < 2 && search
                ? 'Type at least two characters to search.'
                : 'No matching repositories.'}
          </ComboboxEmpty>
          <ComboboxList>
            {(repo: string) => (
              <ComboboxItem key={repo} value={repo}>
                <RepositoryMark repo={repo} settings={settings[repositoryKey(repo)]} />
              </ComboboxItem>
            )}
          </ComboboxList>
          {state === 'error' && (
            <div className="setup-repo-error" role="alert">
              GitHub search failed.{' '}
              <button type="button" onClick={() => setRetry((r) => r + 1)}>
                Retry search
              </button>
            </div>
          )}
        </ComboboxContent>
      </Combobox>
      <div className="setup-repo-tags">
        {value.map((repo) => (
          <span key={repo}>
            <RepositoryMark repo={repo} settings={settings[repositoryKey(repo)]} />
            <button
              type="button"
              aria-label={`Remove ${repo}`}
              onClick={() => onChange(value.filter((v) => v !== repo))}
            >
              <X size={13} />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
