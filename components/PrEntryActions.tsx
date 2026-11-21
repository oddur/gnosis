import { useWorkspaceNavigation } from '../lib/workspace-navigation';
import { WorkspaceIcon } from './WorkspaceIcon';
import { WorkbenchIcon } from './WorkbenchIcon';
import { useContext } from 'react';
import { PrReadContext } from '../lib/pr-read-context';
import { Mail, MailOpen } from 'lucide-react';
import { AlarmClock, Copy, ExternalLink, Link, RefreshCw, Star, VolumeX } from 'lucide-react';
import { conflictIcon as ConflictIcon } from '../lib/interface-icons';
import { canSnooze, openSnoozePicker } from '../lib/snooze-picker';
import { prDeepLinks } from '../lib/deep-link';
import type { ReviewMember } from '../lib/workbench';
import { EntryActions, type EntryActionGroups } from './EntryActions';
import type { ComponentProps } from 'react';
import { isLocalUrl } from '../lib/local-url';
import { openConflictWorkspace } from '../lib/open-conflict-workspace';
import { mergeConflictState, offersConflictResolution, type MergeConflictState } from '../lib/merge-conflicts';
import { queueSignalKey, type QueueSignals } from '../lib/queue-signals';
import { Bell } from 'lucide-react';
import { useRepositorySettings, type RepositoryContextValue } from '../lib/use-repository-settings';
import { REPOSITORY_NOTIFICATION_LEVELS, REPOSITORY_NOTIFICATION_SHORT_LABEL } from '../lib/notification-settings';

export interface PrGenerationActions {
  onGenerateExplanation: () => unknown;
  onGenerateBriefing: () => unknown;
  explanationDisabled?: boolean;
  briefingDisabled?: boolean;
  stackBriefing?: boolean;
}
export type PrGenerationActionsFor = (members: ReviewMember[]) => PrGenerationActions;

/**
 * The star toggle, in one set of words wherever it is offered (the queue's menus and the Overview's): "Star PR #312"
 * and "Unstar PR #312", and for a stack "Star all PRs in this stack" and "Unstar PRs in this stack". Unstarring a stack
 * unstars every PR of it. `busy`: a star change is being saved, so the toggle waits rather than being dropped.
 */
export function starAction({ members, starred, busy, onStarChange }: {
  members: readonly ReviewMember[];
  starred: boolean;
  busy?: boolean;
  onStarChange: (members: ReviewMember[], starred: boolean) => unknown;
}): EntryActionGroups[number][number] {
  const stack = members.length > 1;
  return {
    label: stack ? (starred ? 'Unstar PRs in this stack' : 'Star all PRs in this stack') : `${starred ? 'Unstar' : 'Star'} PR #${members[0].number}`,
    icon: <Star size={15} />,
    disabled: busy,
    run: () => onStarChange([...members], !starred),
  };
}

export function prEntryActionGroups({
  members,
  starredUrls,
  busy,
  onStarChange,
  onMute,
  onSnooze,
  onRefresh,
  onGenerateExplanation,
  onGenerateBriefing,
  explanationDisabled,
  briefingDisabled,
  stackBriefing,
  onReview,
  reviewDisabled,
  onReadChange,
  onOpenTab,
  unread,
  repositories,
  conflictState,
}: Partial<PrGenerationActions> & {
  /** Offers "Notifications from org/repo: All / On me / None" (#385). */
  repositories?: RepositoryContextValue;
  members: ReviewMember[];
  starredUrls: ReadonlySet<string>;
  busy?: boolean;
  onStarChange: (members: ReviewMember[], starred: boolean) => unknown;
  onMute?: (members: ReviewMember[]) => unknown;
  /** Opens the Snooze picker. Wherever Mute is offered, Snooze is too, directly above it. */
  onSnooze?: (members: ReviewMember[]) => unknown;
  onRefresh?: () => unknown;
  onReview?: (member: ReviewMember) => unknown;
  reviewDisabled?: boolean;
  unread?: boolean;
  onReadChange?: (read: boolean) => unknown;
  onOpenTab?: () => unknown;
  /** Where GitHub's merge state is known, "Resolve conflicts…" is offered only for conflicts or a pending answer. */
  conflictState?: (member: ReviewMember) => MergeConflictState;
}): EntryActionGroups {
  if (!members.length) return [];
  const starred = members.some((m) => starredUrls.has(m.url));
  const stack = members.length > 1;
  return [
    onOpenTab ? [{label:'Open in new tab',dismissBeforeRun:true,icon:<ExternalLink size={15}/>,run:onOpenTab}] : [],
    onReadChange ? [{ label: unread ? 'Mark as read' : 'Mark as unread', icon: unread ? <MailOpen size={15} /> : <Mail size={15} />, disabled: busy, run: () => onReadChange(!!unread) }] : [],
    onReview ? members.filter(member => !isLocalUrl(member.url)).map(member => ({
      label: `Review PR #${member.number}…`,
      icon: <WorkbenchIcon name="review" />,
      disabled: reviewDisabled || member.merged || member.state !== 'open',
      run: () => onReview(member),
    })) : [],
    [
      ...(onGenerateExplanation
        ? [
            {
              label: 'Generate explanation',
              icon: <WorkspaceIcon tab="explanation" />,
              disabled: explanationDisabled,
              run: onGenerateExplanation,
            },
          ]
        : []),
      ...(onGenerateBriefing
        ? [
            {
              label: stackBriefing ? 'Generate stack briefing' : 'Generate briefing',
              icon: <WorkbenchIcon name="briefing" />,
              disabled: briefingDisabled,
              run: onGenerateBriefing,
            },
          ]
        : []),
    ],
    [
      starAction({ members, starred, busy, onStarChange }),
      ...(onRefresh
        ? [{ label: 'Refresh GitHub status', icon: <RefreshCw size={15} />, disabled: busy, run: onRefresh }]
        : []),
      ...(!stack && !isLocalUrl(members[0].url) && !members[0].merged && members[0].state === 'open' &&
      offersConflictResolution(conflictState?.(members[0]) ?? 'unchecked')
        ? [{ label: 'Resolve conflicts…', icon: <ConflictIcon size={15} />, disabled: busy, run: () => openConflictWorkspace(members[0].url) }]
        : []),
    ],
    [
      ...(!stack
        ? [
            {
              label: 'Open on GitHub',
              icon: <ExternalLink size={15} />,
              run: () => window.electronAPI.openExternal(members[0].url),
            },
          ]
        : []),
      {
        label: stack ? 'Copy PR links' : 'Copy PR link',
        icon: <Copy size={15} />,
        run: () => navigator.clipboard.writeText(members.map((m) => m.url).join('\n')),
      },
      ...(prDeepLinks(members.map((m) => m.url)).length
        ? [
            {
              label: stack ? 'Copy Gnosis links' : 'Copy Gnosis link',
              icon: <Link size={15} />,
              run: () => navigator.clipboard.writeText(prDeepLinks(members.map((m) => m.url), window.electronAPI.linkScheme).join('\n')),
            },
          ]
        : []),
    ],
    // Beside Snooze and Mute: all three decide what reaches you.
    repositories ? repositoryNotificationActions(members, repositories) : [],
    onMute
      ? [
          ...(canSnooze(members) && !members.some((member) => isLocalUrl(member.url))
            ? [
                {
                  label: stack ? 'Snooze stack…' : 'Snooze PR…',
                  icon: <AlarmClock size={15} />,
                  disabled: busy,
                  dismissBeforeRun: true,
                  run: () => (onSnooze ? onSnooze(members) : openSnoozePicker({ groups: [members] })),
                },
              ]
            : []),
          {
            label: stack ? 'Mute stack' : 'Mute PR',
            icon: <VolumeX size={15} />,
            disabled: busy,
            run: () => onMute(members),
          },
        ]
      : [],
  ];
}
/** `conflictState` from the status values a page already holds. Only a value for the member's head counts. */
export const conflictStateFrom = (signals: readonly (QueueSignals | undefined)[]) => (member: ReviewMember) =>
  mergeConflictState(signals.find((value) => value && queueSignalKey(value) === queueSignalKey(member)));
/** "Notifications from org/repo: All / On me / None", once per repository of the PRs. */
export function repositoryNotificationActions(members: readonly Pick<ReviewMember, 'repo' | 'url'>[], context: RepositoryContextValue) {
  const { notificationLevel, setNotificationLevel } = context;
  if (!notificationLevel || !setNotificationLevel) return [];
  const repos = [...new Map(members.filter((member) => !isLocalUrl(member.url)).map((member) => [member.repo.toLowerCase(), member.repo])).values()];
  return repos.flatMap((repo) => {
    const current = notificationLevel(repo).level;
    return REPOSITORY_NOTIFICATION_LEVELS.map((level) => ({
      label: `Notifications from ${repo}: ${REPOSITORY_NOTIFICATION_SHORT_LABEL[level]}`,
      icon: <Bell size={15} />,
      ...(level === current ? { detail: 'Current', disabled: true } : {}),
      run: () => setNotificationLevel(repo, level),
    }));
  });
}
export function PrEntryActions(
  props: Parameters<typeof prEntryActionGroups>[0] & {
    children?: ComponentProps<typeof EntryActions>['children'];
    onBeforeOpen?: () => void;
  }
) {
  const tabs=useWorkspaceNavigation();
  const read = useContext(PrReadContext);
  const repositories = useRepositorySettings();
  const canMark = read && props.members.some(member => read.states[member.url]);
  const groups = prEntryActionGroups({ ...props, repositories: props.repositories ?? repositories, onOpenTab: props.onOpenTab ?? (tabs && props.members.length===1 && !isLocalUrl(props.members[0].url) ? ()=>tabs.open({kind:'home',url:props.members[0].url}) : undefined), ...(canMark ? {
        unread: props.members.some(member => read.states[member.url]?.unread.length),
        busy: props.busy || read.busy,
        onReadChange: value => read.change(props.members.map(member => member.url), value),
      } : {}) });
  return (
    <EntryActions
      onBeforeOpen={props.onBeforeOpen}
      label={props.members.length > 1 ? 'Stack actions' : `Actions for PR #${props.members[0]?.number}`}
      groups={groups}
    >
      {props.children}
    </EntryActions>
  );
}
export function PrStarMarker({ members, starredUrls }: { members: ReviewMember[]; starredUrls: ReadonlySet<string> }) {
  const count = members.filter((m) => starredUrls.has(m.url)).length;
  return count ? (
    <span className="entry-star-marker" title={`${count} of ${members.length} PRs starred`}>
      <Star size={13} fill="currentColor" aria-label="Starred" />
    </span>
  ) : null;
}
