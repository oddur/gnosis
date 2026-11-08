import { useWorkspaceNavigation } from '../lib/workspace-navigation';
import { WorkspaceIcon } from './WorkspaceIcon';
import { WorkbenchIcon } from './WorkbenchIcon';
import { useContext } from 'react';
import { PrReadContext } from '../lib/pr-read-context';
import { Mail, MailOpen } from 'lucide-react';
import { Copy, ExternalLink, RefreshCw, Star, VolumeX } from 'lucide-react';
import type { ReviewMember } from '../lib/workbench';
import { EntryActions, type EntryActionGroups } from './EntryActions';
import type { ComponentProps } from 'react';
import { isLocalUrl } from '../lib/local-url';
import { openConflictWorkspace } from '../lib/open-conflict-workspace';
import { GitBranch } from 'lucide-react';

export interface PrGenerationActions {
  onGenerateExplanation: () => unknown;
  onGenerateBriefing: () => unknown;
  explanationDisabled?: boolean;
  briefingDisabled?: boolean;
  stackBriefing?: boolean;
}
export type PrGenerationActionsFor = (members: ReviewMember[]) => PrGenerationActions;

export function prEntryActionGroups({
  members,
  starredUrls,
  busy,
  onStarChange,
  onMute,
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
}: Partial<PrGenerationActions> & {
  members: ReviewMember[];
  starredUrls: ReadonlySet<string>;
  busy?: boolean;
  onStarChange: (members: ReviewMember[], starred: boolean) => unknown;
  onMute?: (members: ReviewMember[]) => unknown;
  onRefresh?: () => unknown;
  onReview?: (member: ReviewMember) => unknown;
  reviewDisabled?: boolean;
  unread?: boolean;
  onReadChange?: (read: boolean) => unknown;
  onOpenTab?: () => unknown;
}): EntryActionGroups {
  if (!members.length) return [];
  const starred = members.some((m) => starredUrls.has(m.url));
  const stack = members.length > 1;
  return [
    onOpenTab ? [{label:'Open in new tab',icon:<ExternalLink size={15}/>,run:onOpenTab}] : [],
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
      {
        label: stack
          ? starred
            ? 'Unstar PRs in this stack'
            : 'Star all PRs in this stack'
          : `${starred ? 'Unstar' : 'Star'} PR #${members[0].number}`,
        icon: <Star size={15} />,
        disabled: busy,
        run: () => onStarChange(members, !starred),
      },
      ...(onRefresh
        ? [{ label: 'Refresh GitHub status', icon: <RefreshCw size={15} />, disabled: busy, run: onRefresh }]
        : []),
      ...(!stack && !isLocalUrl(members[0].url) && !members[0].merged && members[0].state === 'open'
        ? [{ label: 'Conflict resolution & restack…', icon: <GitBranch size={15} />, disabled: busy, run: () => openConflictWorkspace(members[0].url) }]
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
    ],
    onMute
      ? [
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
export function PrEntryActions(
  props: Parameters<typeof prEntryActionGroups>[0] & {
    children?: ComponentProps<typeof EntryActions>['children'];
    onBeforeOpen?: () => void;
  }
) {
  const tabs=useWorkspaceNavigation();
  const read = useContext(PrReadContext);
  const canMark = read && props.members.some(member => read.states[member.url]);
  return (
    <EntryActions
      onBeforeOpen={props.onBeforeOpen}
      label={props.members.length > 1 ? 'Stack actions' : `Actions for PR #${props.members[0]?.number}`}
      groups={prEntryActionGroups({ ...props, onOpenTab: props.onOpenTab ?? (tabs && props.members.length===1 && !isLocalUrl(props.members[0].url) ? ()=>tabs.open({kind:'home',url:props.members[0].url}) : undefined), ...(canMark ? {
        unread: props.members.some(member => read.states[member.url]?.unread.length),
        busy: props.busy || read.busy,
        onReadChange: value => read.change(props.members.map(member => member.url), value),
      } : {}) })}
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
