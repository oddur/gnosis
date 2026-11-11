import { memo, useReducer, type ReactNode } from 'react';
import { ArrowRight, Check, ChevronDown, ChevronRight, GitPullRequest, Layers, Loader2, MessageSquare, Square, SquareCheck } from 'lucide-react';
import { EntryActions, type EntryActionGroups } from './EntryActions';
import { PrEntryActions, PrStarMarker } from './PrEntryActions';
import { PrLabels } from './PrLabels';
import { QueueMetadata, PrStateIcon } from './QueueMetadata';
import { UnreadPrMarker } from './UnreadPrMarker';
import { needsResponse } from '../lib/response-needed';
import { focusStackPr, matchingStackMembers } from '../lib/stack-workspace';
import { useWorkspaceNavigation } from '../lib/workspace-navigation';
import type { ResponseIntent } from '../lib/feedback';
import type { SelectionModifiers } from '../lib/entry-selection';
import type { QueueFilters } from '../lib/queue-filters';
import type { QueueItem, ReviewMember, WorkbenchQueue } from '../lib/workbench';
import type { ComponentProps } from 'react';

/**
 * Stable callbacks for every row. HomePage creates them once and reads its latest state when
 * they run, so rows re-render only when their own props change.
 */
export interface QueueRowActions {
  select: (id: string, modifiers?: SelectionModifiers) => void;
  move: (direction: number, modifiers?: SelectionModifiers) => void;
  activate: (item: QueueItem) => void;
  openMember: (item: QueueItem, member: ReviewMember, modifiers: SelectionModifiers) => void;
  openChecks: (item: QueueItem) => void;
  openResponse: (item: QueueItem, intent: ResponseIntent) => void;
  toggleExpanded: (id: string) => void;
  selectAll: () => void;
  toggleSelect: (id: string, modifiers: SelectionModifiers) => void;
  /** Clears a multiple selection; returns false when nothing was selected. */
  clearSelection: () => boolean;
  contextSelect: (id: string) => void;
  menuGroups: (item: QueueItem) => EntryActionGroups;
  memberMenu: (member: ReviewMember) => Omit<ComponentProps<typeof PrEntryActions>, 'children'>;
  registerButton: (id: string, node: HTMLButtonElement | null) => void;
}

interface Props {
  item: QueueItem;
  /** The keyboard selection. Part of the row's identity for memoization; `tabStop` derives from it. */
  focused: boolean;
  active: boolean;
  multiple: boolean;
  /** This row is part of a multiple selection, so its menu acts on every selected entry. */
  bulk: boolean;
  tabStop: boolean;
  expanded: boolean;
  selectedCount: number;
  account: string | null;
  filters: QueueFilters;
  starredUrls: ReadonlySet<string>;
  readStates: NonNullable<WorkbenchQueue['readStates']>;
  /** Changes whenever menu content would change, such as busy states, stars or sign-in. */
  menuKey: string;
  bulkMenu?: { groups: EntryActionGroups; description: ReactNode };
  actions: QueueRowActions;
}

declare global {
  interface Window {
    /** Browser checks count row renders when this is set. */
    __countRenders?: boolean;
    __queueRowRenders?: number;
  }
}

export const QueueRow = memo(function QueueRow({ item, active, multiple, bulk, tabStop, expanded, selectedCount, account, filters, starredUrls, readStates, bulkMenu, actions }: Props) {
  if (window.__countRenders) window.__queueRowRenders = (window.__queueRowRenders ?? 0) + 1;
  const tabs = useWorkspaceNavigation();
  // Menu content reads HomePage state when the menu opens, so render once more on open.
  const [, refreshMenu] = useReducer((count: number) => count + 1, 0);
  const s = item.subject;
  const matching = s.kind === 'stack' || filters.involvement === 'response' ? matchingStackMembers(item, filters, account) : [];
  return (
    <div className={`queue-item ${active ? 'is-selected' : ''} ${item.unreadUrls?.length ? 'is-unread' : ''}`}>
      <EntryActions
        label={bulk ? `Actions for ${selectedCount} selected entries` : s.kind === 'stack' ? 'Stack actions' : `Actions for PR #${s.members[0].number}`}
        groups={bulk && bulkMenu ? bulkMenu.groups : actions.menuGroups(item)}
        description={bulk ? bulkMenu?.description : undefined}
        onBeforeOpen={() => { refreshMenu(); actions.contextSelect(s.id); }}
      >{menu => <div className="queue-row">
        {s.kind !== 'stack' ? <span className="queue-pr-gutter"><PrStateIcon member={s.members[0]} /></span> : <button
          className="queue-disclosure"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${s.title}`}
          aria-expanded={expanded}
          aria-controls={`members-${s.id}`}
          onClick={() => actions.toggleExpanded(s.id)}
        >
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>}
        <div className="queue-row-content"
          onClick={event => { if ((event.target as HTMLElement).closest('a,button')) return; actions.select(s.id, event); }}
          onDoubleClick={event => { if (event.shiftKey || event.metaKey || event.ctrlKey || (event.target as HTMLElement).closest('a,button')) return; actions.activate(item); }}>
        <div className="queue-row-heading">
        <button
          className="queue-row-main"
          ref={(node) => actions.registerButton(s.id, node)}
          aria-pressed={active}
          tabIndex={tabStop ? 0 : -1}
          aria-describedby="queue-keyboard-help"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              actions.move(e.key === 'ArrowDown' ? 1 : -1, e);
            } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
              e.preventDefault(); actions.selectAll();
            } else if ((e.metaKey || e.ctrlKey) && e.key === ' ') {
              e.preventDefault(); actions.toggleSelect(s.id, e);
            } else if (e.key === 'Escape') {
              if (actions.clearSelection()) { e.preventDefault(); e.stopPropagation(); }
            } else if (e.key === 'Enter' && active && !e.repeat) {
              e.preventDefault();
              actions.activate(item);
            }
          }}
          onClick={event => {
            if (tabs && (event.metaKey || event.ctrlKey) && !event.altKey) { event.preventDefault(); tabs.open({ kind: 'home', subject: item }, !event.shiftKey); return; }
            actions.select(s.id, event);
          }}
          onAuxClick={event => { if (event.button === 1 && tabs) { event.preventDefault(); tabs.open({ kind: 'home', subject: item }, true); } }}
          onDoubleClick={event => {
            if (event.shiftKey || event.metaKey || event.ctrlKey) return;
            actions.activate(item);
          }}
        >
          <span className="queue-title-line">
            {multiple && (active ? <SquareCheck size={16} className="queue-selection-check" aria-hidden="true" /> : <Square size={16} className="queue-selection-check" aria-hidden="true" />)}
            {s.kind === 'stack' && <Layers size={16} aria-label="PR stack" className="queue-stack-icon" />}
            <span className="queue-title">{s.title}</span>
            <PrLabels members={s.members} limit={3} />
          </span>
        </button>
        <UnreadPrMarker urls={s.members.map(member => member.url)} />
        <PrStarMarker members={s.members} starredUrls={starredUrls} />
        {menu}
        {(item.review?.status === 'generating' ||
          item.review?.status === 'completed' ||
          item.briefing?.status === 'generating') && (
          <span className={`queue-state ${item.attention === 'updated' ? 'needs-attention' : ''}`}>
            {item.review?.status === 'generating' ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                Generating explanation
              </>
            ) : item.review?.status === 'completed' ? (
              <>
                <Check size={13} />
                Explanation ready
              </>
            ) : item.briefing?.status === 'generating' ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                Generating briefing
              </>
            ) : null}
          </span>
        )}
        </div>
          <QueueMetadata onChecks={() => actions.openChecks(item)} subject={s} account={account} />
          {s.kind === 'stack' && matching.length < s.members.length && <span className="queue-stack-matches">{matching.length} of {s.members.length} PRs match</span>}
          {filters.involvement === 'response' && <div className="queue-response-reasons">{s.members.flatMap(member => {
            const response = item.responses?.[member.url];
            if (!response || !needsResponse(response) || !matching.includes(member.url)) return [];
            return [<span key={member.url} className="queue-response-pr">
              {s.kind === 'stack' && <span className="queue-response-source"><GitPullRequest size={12} aria-hidden="true" />#{member.number}</span>}
              {response.changesRequested && <button onClick={() => actions.openResponse(focusStackPr(item, member), 'response-review')} aria-label={`Read changes requested on PR #${member.number}: ${member.title}`}><MessageSquare size={14} aria-hidden="true" />Changes requested<ArrowRight size={12} aria-hidden="true" /></button>}
              {response.unresolvedThreads > 0 && <button onClick={() => actions.openResponse(focusStackPr(item, member), 'response-threads')} aria-label={`Address ${response.unresolvedThreads} unresolved threads on PR #${member.number}: ${member.title}`}>{response.unresolvedThreads} unresolved {response.unresolvedThreads === 1 ? 'thread' : 'threads'}<ArrowRight size={12} aria-hidden="true" /></button>}
            </span>];
          })}</div>}
          {item.briefing?.summary && <span className="queue-summary">{item.briefing.summary}</span>}
        </div>
      </div>}</EntryActions>
      {expanded && (
        <div id={`members-${s.id}`}>
          {s.members.map((m) => (
            <PrEntryActions key={m.url} {...actions.memberMenu(m)}>{menu => <div className={`queue-member ${readStates[m.url]?.unread.length ? 'is-unread' : ''}`}>
              <PrStateIcon member={m} />
              <div className="queue-member-content">
                <button className="queue-member-title" onClick={event => actions.openMember(item, m, event)}>
                  <span className="truncate">{m.title}</span>
                  <PrLabels members={[m]} />
                </button>
                <QueueMetadata onChecks={() => actions.openChecks(focusStackPr(item, m))} subject={{ id: m.url, kind: 'pr', title: m.title, members: [m], edges: [], warnings: [] }} account={account} />
              </div>
              <UnreadPrMarker urls={[m.url]} />
              <PrStarMarker members={[m]} starredUrls={starredUrls} />{menu}
            </div>}</PrEntryActions>
          ))}
        </div>
      )}
    </div>
  );
});
