import { PrBadge, RepositoryBadge } from './EntityBadge';
import { GitHubAuthor } from './GitHubAuthor';
import { useLayoutEffect, useRef, useState } from 'react';
import { Search, VolumeX } from 'lucide-react';
import type { MutedPr } from '../lib/muted-prs';
import type { ReviewMember } from '../lib/workbench';
import { Button } from './ui/button';

export function MutedPrs({
  entries,
  busy,
  error,
  onUnmute,
}: {
  entries: MutedPr[];
  busy: boolean;
  error: string;
  onUnmute: (members: ReviewMember[]) => void;
}) {
  const [query, setQuery] = useState('');
  const section = useRef<HTMLElement>(null);
  const previousCount = useRef(entries.length);
  useLayoutEffect(() => {
    if (entries.length < previousCount.current) {
      const next = section.current?.querySelector<HTMLElement>('.muted-pr-list .muted-pr-restore, h1');
      // Prefer another restore action; when the list is empty, focus its heading.
      (section.current?.querySelector<HTMLButtonElement>('.muted-pr-list .muted-pr-restore') ?? next)?.focus();
    }
    previousCount.current = entries.length;
  }, [entries.length]);
  const matches = entries.filter(({ member: m }) =>
    `${m.title} ${m.repo} #${m.number} ${m.author}`.toLowerCase().includes(query.trim().toLowerCase())
  );
  return (
    <section ref={section} className="muted-prs" aria-labelledby="muted-prs-title">
      <header>
        <h1 id="muted-prs-title" tabIndex={-1}>
          Muted PRs <span>{entries.length}</span>
        </h1>
        <p>Hidden from your queue, Starred, saved reviews, and search. Automatic briefings are paused.</p>
        <p>
          Saved on this computer for your GitHub account. Unmute to restore a PR, including its stars and saved
          explanations.
        </p>
      </header>
      {error && (
        <p role="alert" className="muted-prs-error">
          {error}
        </p>
      )}
      {!!entries.length && (
        <label className="queue-search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="Search muted PRs"
            placeholder="Find a muted PR…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
      {matches.length ? (
        <ul className="muted-pr-list">
          {matches.map(({ member: m }) => (
            <li key={m.url}>
              <div>
                <strong>{m.title}</strong>
                <p>
                  <RepositoryBadge repo={m.repo} /> <PrBadge url={m.url} number={m.number} title={m.title} /> <GitHubAuthor login={m.author} /> ·{' '}
                  {m.merged ? 'Merged' : m.state === 'closed' ? 'Closed' : m.isDraft ? 'Draft' : 'Open'}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                className="muted-pr-restore" aria-label={`Unmute PR #${m.number}`}
                onClick={() => onUnmute([m])}
              >
                Unmute
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="queue-empty">
          <VolumeX size={24} aria-hidden="true" />
          <h2>{entries.length ? 'No matching muted PRs' : 'No muted PRs'}</h2>
          <p>
            {entries.length
              ? 'Try another title, PR number, author, or repository.'
              : 'Use the more actions menu on a PR or stack to hide work you don’t need to follow.'}
          </p>
        </div>
      )}
    </section>
  );
}
