import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlarmClock, Search } from 'lucide-react';
import { PrBadge, RepositoryBadge } from './EntityBadge';
import { GitHubAuthor } from './GitHubAuthor';
import { PrStateIcon } from './PrStateIcon';
import { Button } from './ui/button';
import { wakesLine, type SnoozedPr } from '../lib/snooze';
import { openSnoozePicker } from '../lib/snooze-picker';

const target = ({ member }: SnoozedPr) => ({ ...member, requestedReviewers: [] });

/** Tools › Snoozed: each snoozed PR, when or why it wakes, and Unsnooze. */
export function SnoozedPrs({
  entries,
  busy,
  onUnsnooze,
  onMute,
}: {
  entries: readonly SnoozedPr[];
  busy: boolean;
  onUnsnooze: (urls: string[]) => void;
  onMute: (urls: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const section = useRef<HTMLElement>(null);
  const previousCount = useRef(entries.length);
  // Minutes matter for "Wakes today 6:30 PM", not seconds: read the clock once per render.
  const now = Date.now();
  useLayoutEffect(() => {
    // After an unsnooze, focus the next Unsnooze, or the heading when the list is empty.
    if (entries.length < previousCount.current)
      (section.current?.querySelector<HTMLElement>('.snoozed-pr-list .snoozed-pr-restore') ?? section.current?.querySelector<HTMLElement>('h1'))?.focus();
    previousCount.current = entries.length;
  }, [entries.length]);
  const matches = useMemo(() => {
    const words = query.trim().toLowerCase();
    return entries.filter(({ member: m }) => `${m.title} ${m.repo} #${m.number} ${m.author}`.toLowerCase().includes(words));
  }, [entries, query]);
  const groupOf = (entry: SnoozedPr) => entries.filter((other) => other.group === entry.group);
  return (
    <section ref={section} className="muted-prs snoozed-prs" aria-labelledby="snoozed-prs-title">
      <header>
        <div className="snoozed-prs-title-row">
          <h1 id="snoozed-prs-title" tabIndex={-1}>
            Snoozed <span>{entries.length}</span>
          </h1>
          {entries.length > 1 && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onUnsnooze(entries.map((entry) => entry.member.url))}>
              Unsnooze all
            </Button>
          )}
        </div>
        <p>Hidden from your queue, counts, the menu bar and notifications. Gnosis keeps watching them and brings each one back when it wakes.</p>
      </header>
      {!!entries.length && (
        <label className="queue-search">
          <Search size={15} aria-hidden="true" />
          <input aria-label="Search snoozed PRs" placeholder="Find a snoozed PR…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      )}
      {matches.length ? (
        <ul className="muted-pr-list snoozed-pr-list">
          {matches.map((entry) => {
            const m = entry.member;
            const group = groupOf(entry);
            return (
              <li key={m.url}>
                <div>
                  <strong>
                    <PrStateIcon pr={m} size={15} className="snoozed-pr-icon" />
                    {m.title}
                  </strong>
                  <p>
                    <RepositoryBadge repo={m.repo} /> <PrBadge url={m.url} number={m.number} title={m.title} /> <GitHubAuthor login={m.author} />
                    {group.length > 1 && <> · snoozed with {group.length - 1} other {group.length === 2 ? 'PR' : 'PRs'} in its stack</>}
                  </p>
                  <p className="snoozed-pr-wakes">
                    <AlarmClock size={13} aria-hidden="true" />
                    {wakesLine(entry, now)}
                  </p>
                </div>
                <div className="snoozed-pr-actions">
                  <Button size="sm" variant="ghost" disabled={busy} aria-label={`Change snooze for PR #${m.number}`} onClick={() => openSnoozePicker({ groups: [group.map(target)] })}>
                    Change
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} aria-label={`Mute PR #${m.number} instead`} onClick={() => onMute([m.url])}>
                    Mute instead
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} className="snoozed-pr-restore" aria-label={`Unsnooze PR #${m.number}`} onClick={() => onUnsnooze([m.url])}>
                    Unsnooze
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="queue-empty">
          <AlarmClock size={24} aria-hidden="true" />
          <h2>{entries.length ? 'No matching snoozed PRs' : 'No snoozed PRs'}</h2>
          <p>
            {entries.length
              ? 'Try another title, PR number, author, or repository.'
              : 'Press Z on a PR, or use its more actions menu, to hide it until later or until something changes.'}
          </p>
        </div>
      )}
    </section>
  );
}
