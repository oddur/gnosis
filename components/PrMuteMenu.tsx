import { DropdownMenu } from 'radix-ui';
import { MoreHorizontal, VolumeX } from 'lucide-react';
import type { ReviewMember } from '../lib/workbench';

export function PrMuteMenu({
  members,
  busy,
  onMute,
}: {
  members: ReviewMember[];
  busy?: boolean;
  onMute: (members: ReviewMember[]) => void;
}) {
  const label = members.length > 1 ? 'Mute stack' : 'Mute PR';
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="pr-star-button"
          disabled={busy}
          aria-label={members.length > 1 ? 'Stack actions' : `Actions for PR #${members[0].number}`}
          title="More actions"
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="saved-view-menu pr-mute-menu" align="end" sideOffset={4} collisionPadding={12}>
          <DropdownMenu.Item onSelect={() => onMute(members)}>
            <VolumeX size={15} aria-hidden="true" />
            {label}
          </DropdownMenu.Item>
          <p>
            Hide {members.length > 1 ? `these ${members.length} PRs` : 'this PR'} in Gnosis. Restore from Muted PRs.
          </p>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
