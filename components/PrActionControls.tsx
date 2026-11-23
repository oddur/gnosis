import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
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

/**
 * Rendered while a popover or menu is open: it closes when its scope is hidden and when the window loses focus.
 * Workspaces stay mounted inside React <Activity>, which hides the control but not its portaled popup, and removes the
 * effects that would close it. Hiding destroys this layout effect: the popup is hidden in the same commit, so it never
 * paints without its control, then closed (as `components/ui/tooltip.tsx` does for tooltips).
 */
export function CloseWhenHidden({ open, onClose, content }: { open: boolean; onClose: () => void; content: RefObject<HTMLElement | null> }) {
  const latest = useRef(onClose);
  useLayoutEffect(() => {
    latest.current = onClose;
  });
  // The open state this render asks for. A watcher removed while it is still true was not closed by its owner: its
  // scope was hidden (or it unmounted). A normal close renders `open` false first, and is left alone.
  const wanted = useRef(open);
  wanted.current = open;
  const watching = useRef(false);
  useLayoutEffect(() => {
    if (!open) return;
    watching.current = true;
    if (content.current) content.current.style.display = '';
    return () => {
      watching.current = false;
      if (!wanted.current) return;
      if (content.current) content.current.style.display = 'none';
      // StrictMode runs the effect again at once; only a scope that stays hidden closes.
      queueMicrotask(() => {
        if (!watching.current && wanted.current) latest.current();
      });
    };
  }, [open, content]);
  useEffect(() => {
    if (!open) return;
    const close = () => latest.current();
    window.addEventListener('blur', close);
    return () => window.removeEventListener('blur', close);
  }, [open]);
  return null;
}

/** Open state for a menu that may be controlled, closed with its scope (`CloseWhenHidden`). */
function useMenuOpen(open: boolean | undefined, onOpenChange: ((open: boolean) => void) | undefined) {
  const [own, setOwn] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const isOpen = open ?? own;
  const change = (next: boolean) => {
    setOwn(next);
    onOpenChange?.(next);
  };
  const guard = <CloseWhenHidden open={isOpen} onClose={() => change(false)} content={content} />;
  return { isOpen, change, content, guard };
}

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
export function MethodMenu({ label, methods, allowed, current, reason, onPick, onOpen, size = 'sm', variant = 'outline' }: {
  label: string;
  methods: readonly MergeMethod[];
  /** The repository's allowed methods; the others show disabled. Undefined while they are being read. */
  allowed?: readonly MergeMethod[];
  current?: MergeMethod;
  reason?: string;
  onPick: (method: MergeMethod) => void;
  /** Reads the allowed methods when the menu opens. */
  onOpen?: () => void;
  size?: 'sm' | 'xs';
  variant?: 'default' | 'outline';
}) {
  const menu = useMenuOpen(undefined, (open) => { if (open) onOpen?.(); });
  return (
    <>
    {menu.guard}
    <DropdownMenu.Root open={menu.isOpen} onOpenChange={menu.change}>
      <DropdownMenu.Trigger asChild disabled={!!reason}>
        <Button size={size === 'sm' ? 'icon-sm' : 'icon-xs'} variant={variant} className="pr-action-chevron" aria-label={label} title={reason ?? label}>
          <ChevronDown size={14} aria-hidden="true" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        {/* Picking a method opens Merge's confirmation, which takes focus: focus must not return to the chevron and close it. */}
        <DropdownMenu.Content ref={menu.content} className="pr-update-menu pr-method-menu" align="end" sideOffset={5} onCloseAutoFocus={(event) => event.preventDefault()}>
          <DropdownMenu.Label className="pr-method-menu-label">{label}</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={current} onValueChange={(value) => onPick(value as MergeMethod)}>
            {methods.map((method) => {
              // A method the repository does not allow stays listed, disabled with the reason, never swapped for another.
              const unavailableReason = !allowed ? 'Checking this repository’s merge methods…' : !allowed.includes(method) ? 'Not allowed in this repository' : undefined;
              return (
                <DropdownMenu.RadioItem key={method} value={method} disabled={!!unavailableReason} title={unavailableReason}>
                  {mergeMethodLabels[method]}
                  {unavailableReason && <span className="pr-method-unavailable">{unavailableReason === 'Not allowed in this repository' ? 'Not allowed' : 'Checking…'}</span>}
                </DropdownMenu.RadioItem>
              );
            })}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    </>
  );
}

/** Merge as a split button: the main part opens the confirmation, the chevron picks the method first. */
export function MergeSplit({ label, primary, reason, busy, shortcut, methods, allowed, onMethods, current, onMerge, size = 'sm', icon, extra }: {
  label: string;
  primary: boolean;
  reason?: string;
  busy?: boolean;
  shortcut?: string;
  methods?: readonly MergeMethod[];
  /** The repository's allowed methods, when known; `methods` lists them all otherwise. */
  allowed?: readonly MergeMethod[];
  onMethods?: () => void;
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
        <MethodMenu label="Merge method" methods={methods} allowed={onMethods ? allowed : (allowed ?? methods)} current={current} reason={reason} onPick={onMerge} onOpen={onMethods} size={size} variant={variant} />
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
  const menu = useMenuOpen(open, onOpenChange);
  return (
    <>
    {menu.guard}
    <DropdownMenu.Root open={blocked ? false : menu.isOpen} onOpenChange={menu.change}>
      <DropdownMenu.Trigger asChild>
        <Button size={size} variant="outline" className="pr-update-trigger" {...unavailable(blocked)} title={blocked ?? (shortcut ? `Update branch (${shortcut})` : 'Update branch')}
          onPointerDown={blocked ? (event) => event.preventDefault() : undefined}>
          <GitBranch size={14} aria-hidden="true" />
          Update
          <ChevronDown size={13} aria-hidden="true" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content ref={menu.content} className="pr-update-menu" align="end" sideOffset={5}>
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
    </>
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
