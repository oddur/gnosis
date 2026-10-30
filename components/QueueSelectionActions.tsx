import { BookOpen, Copy, FileText, Mail, MailOpen, RefreshCw, Star, VolumeX } from 'lucide-react';
import type { EntryActionGroups } from './EntryActions';
import type { QueueItem, ReviewMember } from '../lib/workbench';

export function queueSelectionGroups({
  members,
  starredUrls,
  readStates,
  explanations,
  briefings,
  busy,
  authenticated,
  onRead,
  onStar,
  onMute,
  onRefresh,
  onExplain,
  onBrief,
}: {
  members: ReviewMember[];
  starredUrls: ReadonlySet<string>;
  readStates: Readonly<Partial<Record<string, { unread: readonly unknown[] }>>>;
  explanations: QueueItem[];
  briefings: QueueItem[];
  busy: boolean;
  authenticated: boolean;
  onRead: (urls: string[], read: boolean) => unknown;
  onStar: (members: ReviewMember[], starred: boolean) => unknown;
  onMute: (members: ReviewMember[]) => unknown;
  onRefresh: (members: ReviewMember[]) => unknown;
  onExplain: (items: QueueItem[]) => unknown;
  onBrief: (items: QueueItem[]) => unknown;
}): EntryActionGroups {
  const unread = members.filter((member) => readStates[member.url]?.unread.length);
  const read = members.filter((member) => readStates[member.url] && !readStates[member.url]?.unread.length);
  const starred = members.filter((member) => starredUrls.has(member.url));
  const unstarred = members.filter((member) => !starredUrls.has(member.url));
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  return [
    [
      {
        label: `Mark ${count(unread.length, 'PR')} as read`,
        displayLabel: 'Mark as read',
        detail: count(unread.length, 'PR'),
        icon: <MailOpen size={15} />,
        disabled: busy || !unread.length,
        run: () =>
          onRead(
            unread.map((member) => member.url),
            true
          ),
      },
      {
        label: `Mark ${count(read.length, 'PR')} as unread`,
        displayLabel: 'Mark as unread',
        detail: count(read.length, 'PR'),
        icon: <Mail size={15} />,
        disabled: busy || !read.length,
        run: () =>
          onRead(
            read.map((member) => member.url),
            false
          ),
      },
    ],
    [
      {
        label: `Generate ${count(explanations.length, 'explanation')}`,
        displayLabel: explanations.length === 1 ? 'Generate explanation' : 'Generate explanations',
        detail: String(explanations.length),
        icon: <BookOpen size={15} />,
        disabled: busy || !authenticated || !explanations.length,
        run: () => onExplain(explanations),
      },
      {
        label: `Generate ${count(briefings.length, 'briefing')}`,
        displayLabel: briefings.length === 1 ? 'Generate briefing' : 'Generate briefings',
        detail: String(briefings.length),
        icon: <FileText size={15} />,
        disabled: busy || !authenticated || !briefings.length,
        run: () => onBrief(briefings),
      },
    ],
    [
      {
        label: `Star ${count(unstarred.length, 'PR')}`,
        displayLabel: 'Star',
        detail: count(unstarred.length, 'PR'),
        icon: <Star size={15} />,
        disabled: busy || !authenticated || !unstarred.length,
        run: () => onStar(unstarred, true),
      },
      {
        label: `Unstar ${count(starred.length, 'PR')}`,
        displayLabel: 'Unstar',
        detail: count(starred.length, 'PR'),
        icon: <Star size={15} />,
        disabled: busy || !authenticated || !starred.length,
        run: () => onStar(starred, false),
      },
      {
        label: 'Refresh GitHub status',
        icon: <RefreshCw size={15} />,
        disabled: busy || !authenticated,
        run: () => onRefresh(members),
      },
    ],
    [
      {
        label: 'Copy PR links',
        icon: <Copy size={15} />,
        run: () => navigator.clipboard.writeText(members.map((member) => member.url).join('\n')),
      },
    ],
    [
      {
        label: `Mute ${count(members.length, 'PR')}`,
        displayLabel: 'Mute',
        detail: count(members.length, 'PR'),
        icon: <VolumeX size={15} />,
        disabled: busy || !authenticated,
        run: () => onMute(members),
      },
    ],
  ];
}
