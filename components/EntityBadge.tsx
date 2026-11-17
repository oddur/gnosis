import { RepositoryIcon } from './RepositoryAppearance';
import { WorkbenchIcon } from './WorkbenchIcon';
import { useRepositorySettings } from '../lib/use-repository-settings';
import { repositoryKey } from '../lib/repository-settings';
import type { PrBadgePreview } from '../lib/pr-badge-preview';
import { PrBadgeTooltip } from './PrBadgeTooltip';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import { useCopyToClipboard } from '../lib/use-copy';
import { setEntryMenuOpen, useEntryMenusOpen } from '../lib/entry-menu-state';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu';
import { toast } from './ui/toast';

type Kind = 'pr' | 'repository' | 'branch' | 'commit' | 'user';
const names: Record<Kind, string> = {
  pr: 'PR link',
  repository: 'repository',
  branch: 'branch name',
  commit: 'full commit SHA',
  user: 'username',
};

/** Metadata is a copy control. Navigation belongs to the surrounding title or breadcrumb. */
export function EntityBadge({
  kind,
  value,
  label = value,
  href,
  icon,
  className = '',
  copyOptions = [],
  tooltipContent,
  tooltipHeading,
  tooltipReady = true,
  onTooltipOpenChange,
  menuActions,
  tabIndex,
}: {
  menuActions?: ReactNode;
  /** -1 keeps the badge out of the tab order where its row offers the same actions. */
  tabIndex?: number;
  kind: Kind;
  value: string;
  label?: string;
  href?: string;
  icon?: ReactNode;
  className?: string;
  copyOptions?: { label: string; value: string }[];
  tooltipContent?: ReactNode;
  tooltipHeading?: string;
  tooltipReady?: boolean;
  onTooltipOpenChange?: (open: boolean) => void;
}) {
  const { state, copy } = useCopyToClipboard();
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useRef(Symbol('entity-menu'));
  useEffect(() => {
    const id = menuId.current;
    setEntryMenuOpen(id, menuOpen);
    return () => setEntryMenuOpen(id, false);
  }, [menuOpen]);
  const changeOpen = (next: boolean) => {
    setOpen(next);
    onTooltipOpenChange?.(next);
  };
  const action = `Copy ${names[kind]}`;
  const feedback = state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy. Try again.' : action;
  const split = label.length > 24 ? label.length - 12 : label.length;
  return (
    <ContextMenu
      open={menuOpen}
      onOpenChange={(next) => {
        setMenuOpen(next);
        if (next) changeOpen(false);
      }}
    >
      <TooltipProvider delayDuration={350}>
        <Tooltip open={open && !menuOpen} onOpenChange={changeOpen} disableHoverableContent={!tooltipReady}>
          <TooltipTrigger asChild>
            <ContextMenuTrigger
              render={
                <button
                  ref={button}
                  type="button"
                  className={`entity-badge entity-badge-${kind} ${className}`}
                  data-entity-kind={kind}
                  data-copy-state={state}
                  tabIndex={tabIndex}
                  aria-label={`${action}: ${label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    copy(value);
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') changeOpen(false);
                    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
                    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                      event.preventDefault();
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      event.currentTarget.dispatchEvent(
                        new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left, clientY: rect.bottom })
                      );
                    }
                  }}
                >
                  <span className="entity-badge-icon" aria-hidden="true">
                    <span className="entity-badge-identity">{icon ?? <span className="icon-mask" />}</span>
                  </span>
                  <span className="entity-badge-value" aria-hidden="true">
                    <span className="entity-badge-start">{label.slice(0, split)}</span>
                    {split < label.length && (
                      <span className="entity-badge-tail">
                        <span>{label.slice(split)}</span>
                      </span>
                    )}
                  </span>
                  <span className="sr-only" role="status" aria-live="polite">
                    {state === 'idle' ? '' : feedback}
                  </span>
                </button>
              }
              onContextMenu={(event) => event.stopPropagation()}
            />
          </TooltipTrigger>
          {tooltipReady && (
            <TooltipContent
              side="top"
              sideOffset={6}
              collisionPadding={12}
              hideWhenDetached
              className={`entity-badge-tooltip${tooltipContent && kind === 'user' ? ' github-author-tooltip' : ''}${kind === 'pr' ? ' pr-badge-tooltip' : ''}`}
            >
              <span className="entity-badge-full-value">{tooltipHeading ?? value}</span>
              {kind !== 'pr' && <span className="entity-badge-instruction">{feedback}</span>}
              {tooltipContent}
              {kind === 'pr' && <span className="entity-badge-instruction">{feedback}</span>}
            </TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>
      <ContextMenuContent
        aria-label={`Actions for ${label}`}
        finalFocus={() => button.current}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <ContextMenuItem className="entry-menu-item" onClick={() => copy(value)}>
          <Copy size={15} />
          {action}
        </ContextMenuItem>
        {menuActions}
        {copyOptions.map((option) => (
          <ContextMenuItem key={option.label} className="entry-menu-item" onClick={() => copy(option.value)}>
            <Copy size={15} />
            {option.label}
          </ContextMenuItem>
        ))}
        {href && (
          <>
            <ContextMenuSeparator className="entry-menu-separator" />
            <ContextMenuItem
              className="entry-menu-item"
              onClick={() => {
                void window.electronAPI.openExternal(href).catch(() =>
                  toast.add({
                    type: 'error',
                    title: 'Could not open GitHub',
                    description: 'Try again, or copy the value instead.',
                  })
                );
              }}
            >
              <ExternalLink size={15} />
              Open on GitHub
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function RepositoryBadge({ repo }: { repo?: string }) {
  const { settings, configure } = useRepositorySettings();
  if (!repo) return null;
  const appearance = settings[repositoryKey(repo)] ?? {};
  return <EntityBadge kind="repository" value={repo} href={`https://github.com/${repo}`} icon={<RepositoryIcon settings={appearance} />} className={`repository-color-${appearance.color ?? 'default'}`}
    menuActions={configure && <ContextMenuItem className="entry-menu-item" onClick={() => configure(repo)}><WorkbenchIcon name="settings" />Repository settings…</ContextMenuItem>} />;
}
/**
 * The PR preview a PR badge shows on hover and focus (`PrBadgeTooltip`), read from the saved PR details each time it
 * opens. Shared by `PrBadge` and `PrPreviewTooltip`, so both load, cache and word the preview the same way.
 */
export function usePrBadgePreview(url: string, number?: number | string, title?: string) {
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState<{ url: string; value: PrBadgePreview | null; failed?: boolean }>();
  useEffect(() => {
    if (!open) return;
    let live = true;
    void window.electronAPI
      .getPrBadgePreview(url)
      .then((value) => {
        if (live) setResolved({ url, value: value ?? null });
      })
      .catch(() => {
        if (live) setResolved({ url, value: null, failed: true });
      });
    return () => {
      live = false;
    };
  }, [open, url]);
  const preview = resolved?.url === url ? resolved.value : null;
  const n = number ?? /\/pull\/(\d+)/.exec(url)?.[1];
  return {
    n,
    ready: resolved?.url === url,
    heading: preview ? `${preview.member.repo} #${n}` : url,
    content: <PrBadgeTooltip preview={preview} title={title} failed={resolved?.failed} />,
    onOpenChange: (next: boolean) => {
      if (next) setResolved(undefined);
      setOpen(next);
    },
  };
}
export function PrBadge({ url, number, title }: { url: string; number?: number | string; title?: string }) {
  const preview = usePrBadgePreview(url, number, title);
  const n = preview.n;
  if (!n) return null;
  return (
    <EntityBadge
      kind="pr"
      tooltipHeading={preview.heading}
      tooltipReady={preview.ready}
      tooltipContent={preview.content}
      onTooltipOpenChange={preview.onOpenChange}
      value={url}
      label={`#${n}`}
      href={url}
      copyOptions={[
        { label: 'Copy PR number', value: String(n) },
        ...(title ? [{ label: 'Copy title', value: title }] : []),
      ]}
    />
  );
}
/** Hover and keyboard focus wait this long before a PR preview opens, as on PR badges. */
export const PR_PREVIEW_DELAY = 350;
/**
 * The PR badge's preview on another trigger, such as a row's title button: the same content, loading and delay as
 * `PrBadge`. Keyboard focus waits the same delay, so moving through rows does not flash previews. Closes on Escape,
 * on scroll, on click and while a row menu is open.
 */
export function PrPreviewTooltip({ url, number, title, children }: { url: string; number?: number | string; title?: string; children: ReactElement }) {
  const preview = usePrBadgePreview(url, number, title);
  const menus = useEntryMenusOpen();
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const viaFocus = useRef(false);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const change = (next: boolean) => {
    window.clearTimeout(timer.current);
    if (next && viaFocus.current) {
      // Radix opens at once on focus; keyboard focus waits like hover does.
      timer.current = window.setTimeout(() => {
        setOpen(true);
        preview.onOpenChange(true);
      }, PR_PREVIEW_DELAY);
      return;
    }
    setOpen(next);
    preview.onOpenChange(next);
  };
  return (
    <TooltipProvider delayDuration={PR_PREVIEW_DELAY}>
      <Tooltip open={open && !menus} onOpenChange={change} disableHoverableContent={!preview.ready}>
        <TooltipTrigger
          asChild
          onFocusCapture={() => { viaFocus.current = true; }}
          onPointerMove={() => { viaFocus.current = false; }}
          onKeyDown={(event) => { if (event.key === 'Escape') change(false); }}
        >
          {children}
        </TooltipTrigger>
        {preview.ready && (
          <TooltipContent side="top" sideOffset={6} collisionPadding={12} hideWhenDetached className="entity-badge-tooltip pr-badge-tooltip">
            <span className="entity-badge-full-value">{preview.heading}</span>
            {preview.content}
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  );
}
export function BranchBadge({ branch, repo }: { branch: string; repo?: string }) {
  return (
    <EntityBadge
      kind="branch"
      value={branch}
      href={repo ? `https://github.com/${repo}/tree/${encodeURIComponent(branch)}` : undefined}
    />
  );
}
export function CommitBadge({ sha, repo }: { sha: string; repo?: string }) {
  return (
    <EntityBadge
      kind="commit"
      value={sha}
      label={sha.slice(0, 7)}
      href={repo ? `https://github.com/${repo}/commit/${encodeURIComponent(sha)}` : undefined}
    />
  );
}
/** Only app-owned source metadata uses this parser; prose and code retain their links. */
export function SourceBadges({ source, title }: { source: string; title?: string }) {
  return (
    <span className="entity-badge-group">
      {source.split(' · ').map((part, i) => {
        const match = /^([^\s/]+\/[^\s]+)\s+#(\d+)$/.exec(part);
        return match ? (
          <span className="entity-badge-group" key={i}>
            <RepositoryBadge repo={match[1]} />
            <PrBadge url={`https://github.com/${match[1]}/pull/${match[2]}`} number={match[2]} title={title} />
          </span>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </span>
  );
}
