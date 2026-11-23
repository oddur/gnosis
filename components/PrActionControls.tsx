import type { ReactNode } from 'react';
import { ChevronDown, GitBranch, Loader2 } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { Button } from './ui/button';
import { mergeMethodLabels, type MergeMethod } from '../lib/pr-actions';

/**
 * The PR actions' controls (#542), the same in the PR header, on the Overview and in stack merge details. An unavailable
 * action stays visible and says why in its tooltip: it is `aria-disabled`, so it keeps focus and its reason.
 */
const unavailable = (reason: string | undefined, busy?: boolean) => ({
  'aria-disabled': reason || busy ? true : undefined,
  title: reason,
  'data-unavailable': reason || busy ? '' : undefined,
});
const guard = (blocked: unknown, run: () => void) => () => {
  if (!blocked) run();
};

/** A GitHub setting that acts at once: Draft, Auto-merge. Its state is GitHub's, shown optimistically while sending. */
export function ActionToggle({ label, checked, detail, reason, busy, onToggle, size = 'sm', children }: {
  label: string;
  checked: boolean;
  /** Beside the label while on, such as the auto-merge method. */
  detail?: string;
  reason?: string;
  busy?: boolean;
  onToggle: () => void;
  size?: 'sm' | 'xs';
  /** A chevron menu joined to the toggle. */
  children?: ReactNode;
}) {
  const toggle = (
    <Button
      size={size}
      variant="outline"
      role="switch"
      aria-checked={checked}
      aria-busy={busy || undefined}
      className="pr-action-toggle"
      {...unavailable(reason, busy)}
      onClick={guard(reason || busy, onToggle)}
    >
      <span className="pr-action-switch" data-checked={checked || undefined} aria-hidden="true" />
      {label}
      {checked && detail && <span className="pr-action-toggle-detail">· {detail}</span>}
    </Button>
  );
  return children ? <span className="pr-action-split">{toggle}{children}</span> : toggle;
}

/** The chevron half of a split control: a menu of merge methods. */
export function MethodMenu({ label, methods, current, reason, onPick, size = 'sm', variant = 'outline' }: {
  label: string;
  methods: readonly MergeMethod[];
  current?: MergeMethod;
  reason?: string;
  onPick: (method: MergeMethod) => void;
  size?: 'sm' | 'xs';
  variant?: 'default' | 'outline';
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={!!reason}>
        <Button size={size === 'sm' ? 'icon-sm' : 'icon-xs'} variant={variant} className="pr-action-chevron" aria-label={label} title={reason ?? label}>
          <ChevronDown size={14} aria-hidden="true" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="pr-update-menu pr-method-menu" align="end" sideOffset={5}>
          <DropdownMenu.Label className="pr-method-menu-label">{label}</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={current} onValueChange={(value) => onPick(value as MergeMethod)}>
            {methods.map((method) => (
              <DropdownMenu.RadioItem key={method} value={method}>
                {mergeMethodLabels[method]}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Merge as a split button: the main part opens the confirmation, the chevron picks the method first. */
export function MergeSplit({ label, primary, reason, busy, shortcut, methods, current, onMerge, size = 'sm', icon, extra }: {
  label: string;
  primary: boolean;
  reason?: string;
  busy?: boolean;
  shortcut?: string;
  methods?: readonly MergeMethod[];
  current?: MergeMethod;
  onMerge: (method?: MergeMethod) => void;
  size?: 'sm' | 'xs';
  icon: ReactNode;
  /** The Overview's row shortcut attributes. */
  extra?: Record<string, unknown>;
}) {
  const variant = primary ? 'default' : 'outline';
  return (
    <span className="pr-action-split pr-merge-split" data-primary={primary || undefined}>
      <Button
        size={size}
        variant={variant}
        data-merge-action
        {...extra}
        {...unavailable(reason, busy)}
        title={reason ?? (extra?.title as string | undefined) ?? (shortcut ? `${label} (${shortcut})` : label)}
        onClick={guard(reason || busy, () => onMerge())}
      >
        {busy ? <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" /> : icon}
        {label}
      </Button>
      {!!methods?.length && (
        <MethodMenu label="Merge method" methods={methods} current={current} reason={reason} onPick={onMerge} size={size} variant={variant} />
      )}
    </span>
  );
}

/** Update the branch: one menu of the two ways. Each opens its confirmation. */
export function UpdateMenu({ reason, rebaseReason, baseBranch, headBranch, busy, onUpdate, open, onOpenChange, size = 'sm', shortcut }: {
  reason?: string;
  rebaseReason?: string;
  baseBranch: string;
  headBranch: string;
  busy?: boolean;
  onUpdate: (kind: 'update-merge' | 'update-rebase') => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  size?: 'sm' | 'xs';
  shortcut?: string;
}) {
  const blocked = reason || (busy ? 'Waiting for GitHub…' : undefined);
  return (
    <DropdownMenu.Root open={blocked ? false : open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <Button size={size} variant="outline" className="pr-update-trigger" {...unavailable(blocked)} title={blocked ?? (shortcut ? `Update branch (${shortcut})` : 'Update branch')}
          onPointerDown={blocked ? (event) => event.preventDefault() : undefined}>
          <GitBranch size={14} aria-hidden="true" />
          Update
          <ChevronDown size={13} aria-hidden="true" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="pr-update-menu" align="end" sideOffset={5}>
          <DropdownMenu.Item onSelect={() => onUpdate('update-merge')}>
            <strong>Update with merge commit…</strong>
            <span>Merge {baseBranch} into {headBranch}.</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item disabled={!!rebaseReason} title={rebaseReason} onSelect={() => onUpdate('update-rebase')}>
            <strong>Update with rebase…</strong>
            <span>{rebaseReason ?? `Replay this branch’s commits on ${baseBranch}. Commit history changes.`}</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** A plain header action with an availability reason, such as Reopen or Delete branch. */
export function HeaderAction({ reason, busy, onClick, children, primary = false, title }: {
  reason?: string;
  busy?: boolean;
  onClick: () => void;
  children: ReactNode;
  primary?: boolean;
  title?: string;
}) {
  return (
    <Button size="sm" variant={primary ? 'default' : 'outline'} {...unavailable(reason, busy)} title={reason ?? title} onClick={guard(reason || busy, onClick)}>
      {children}
    </Button>
  );
}
