import { useContext } from 'react';
import { PrReadContext } from '../lib/pr-read-context';
import { Mail, MailOpen } from 'lucide-react';
import { BookOpen, Copy, ExternalLink, FileText, RefreshCw, Star, VolumeX, MessageSquare } from 'lucide-react';
import type { ReviewMember } from '../lib/workbench';
import { EntryActions, type EntryActionGroups } from './EntryActions';
import type { ComponentProps } from 'react';
import { isLocalUrl } from '../lib/local-url';

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
}): EntryActionGroups {
  if (!members.length) return [];
  const starred = members.some((m) => starredUrls.has(m.url));
  const stack = members.length > 1;
  return [
    onReadChange ? [{ label: unread ? 'Mark as read' : 'Mark as unread', icon: unread ? <MailOpen size={15} /> : <Mail size={15} />, disabled: busy, run: () => onReadChange(!!unread) }] : [],
    onReview ? members.filter(member => !isLocalUrl(member.url)).map(member => ({
      label: `Review PR #${member.number}…`,
      icon: <MessageSquare size={15} />,
      disabled: reviewDisabled || member.merged || member.state !== 'open',
      run: () => onReview(member),
    })) : [],
    [
      ...(onGenerateExplanation
        ? [
            {
              label: 'Generate explanation',
              icon: <BookOpen size={15} />,
              disabled: explanationDisabled,
              run: onGenerateExplanation,
            },
          ]
        : []),
      ...(onGenerateBriefing
        ? [
            {
              label: stackBriefing ? 'Generate stack briefing' : 'Generate briefing',
              icon: <FileText size={15} />,
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
  const read = useContext(PrReadContext);
  const canMark = read && props.members.some(member => read.states[member.url]);
  return (
    <EntryActions
      onBeforeOpen={props.onBeforeOpen}
      label={props.members.length > 1 ? 'Stack actions' : `Actions for PR #${props.members[0]?.number}`}
      groups={prEntryActionGroups({ ...props, ...(canMark ? {
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
