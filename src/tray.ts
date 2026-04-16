import { Tray, Menu, nativeImage, app } from 'electron';
import path from 'path';
import type { PrStatus, ReviewHistoryEntry } from '../lib/types';

let tray: Tray | null = null;

const MAX_MENU_REVIEWS = 8;

const RISK_LABEL: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High' };
const PR_STATE_LABEL: Record<string, string> = { open: 'Open', merged: 'Merged', closed: 'Closed' };
const CI_ICON: Record<string, string> = { success: '✓', failure: '✗', pending: '◎', neutral: '–', in_progress: '◎', queued: '–' };

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function formatTimeAgo(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function buildReviewSubmenu(
  review: ReviewHistoryEntry,
  prStatus: PrStatus | null,
  onNavigate: () => void,
  onOpenPr: () => void,
  onOpenUrl: (url: string) => void,
): Electron.MenuItemConstructorOptions[] {
  const items: Electron.MenuItemConstructorOptions[] = [];

  // Actions first
  items.push({ label: 'Open Review', click: onNavigate });
  items.push({ label: 'Open PR on GitHub', click: onOpenPr });
  items.push({ type: 'separator' });

  // Author and time
  items.push({ label: `by ${review.author}  ·  ${formatTimeAgo(review.savedAt)}`, enabled: false });

  // Summary
  if (review.summary) {
    items.push({ type: 'separator' });
    const words = review.summary.split(' ');
    let line = '';
    for (const word of words) {
      if (line.length + word.length + 1 > 55 && line.length > 0) {
        items.push({ label: `  ${line}`, enabled: false });
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) items.push({ label: `  ${line}`, enabled: false });
  }

  items.push({ type: 'separator' });

  // Risk and PR state
  const riskLabel = RISK_LABEL[review.riskLevel] ?? review.riskLevel;
  const stateLabel = review.prState ? PR_STATE_LABEL[review.prState] ?? review.prState : null;
  const infoLine = stateLabel ? `Risk: ${riskLabel}  ·  PR: ${stateLabel}` : `Risk: ${riskLabel}`;
  items.push({ label: infoLine, enabled: false });

  // Live PR status
  if (prStatus) {
    // CI checks
    const ciIcon = CI_ICON[prStatus.ciConclusion] ?? '–';
    const ciLabel = prStatus.ciConclusion === 'success' ? 'Checks passing'
      : prStatus.ciConclusion === 'failure' ? 'Checks failing'
      : prStatus.ciConclusion === 'pending' ? 'Checks running'
      : 'No checks';

    const failedChecks = prStatus.ciChecks.filter(
      (c) => c.conclusion === 'failure' || c.conclusion === 'timed_out',
    );
    if (failedChecks.length > 0) {
      items.push({
        label: `${ciIcon} ${ciLabel} (${failedChecks.length} failed)`,
        submenu: failedChecks.slice(0, 10).map((c) => ({
          label: `  ✗ ${c.name}`,
          click: c.url ? () => onOpenUrl(c.url!) : undefined,
          enabled: !!c.url,
        })),
      });
    } else {
      const total = prStatus.ciChecks.length;
      const passed = prStatus.ciChecks.filter((c) => c.conclusion === 'success').length;
      const checksDetail = total > 0 ? ` (${passed}/${total})` : '';
      items.push({
        label: `${ciIcon} ${ciLabel}${checksDetail}`,
        submenu: total > 0 ? prStatus.ciChecks.slice(0, 15).map((c) => {
          const icon = CI_ICON[c.conclusion ?? c.status] ?? '–';
          return {
            label: `${icon} ${c.name}`,
            click: c.url ? () => onOpenUrl(c.url!) : undefined,
            enabled: !!c.url,
          };
        }) : undefined,
      });
    }

    // Reviews
    const { approved, changesRequested, commented } = prStatus.reviewSummary;
    const reviewParts: string[] = [];
    if (approved > 0) reviewParts.push(`${approved} approved`);
    if (changesRequested > 0) reviewParts.push(`${changesRequested} changes requested`);
    if (commented > 0) reviewParts.push(`${commented} commented`);
    if (reviewParts.length > 0) {
      items.push({ label: `Reviews: ${reviewParts.join(', ')}`, enabled: false });
    }

    // Merge status
    if (prStatus.isDraft) {
      items.push({ label: 'Draft PR', enabled: false });
    } else if (prStatus.mergeable === true && prStatus.ciConclusion === 'success' && approved > 0) {
      items.push({ label: '✓ Ready to merge', enabled: false });
    }
  } else {
    items.push({ label: 'Loading status…', enabled: false });
  }

  // Model and generation time
  if (review.model || review.generationDurationMs) {
    items.push({ type: 'separator' });
    const parts: string[] = [];
    if (review.model) parts.push(review.model);
    if (review.generationDurationMs) {
      const secs = Math.round(review.generationDurationMs / 1000);
      parts.push(secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`);
    }
    items.push({ label: parts.join('  ·  '), enabled: false });
  }

  return items;
}

function getTrayIcon(): Electron.NativeImage {
  let iconDir: string;
  if (app.isPackaged) {
    iconDir = path.join(process.resourcesPath, 'tray');
  } else {
    iconDir = path.join(app.getAppPath(), 'Icon', 'tray');
  }

  if (process.platform === 'darwin') {
    const templatePath = path.join(iconDir, 'trayTemplate.png');
    const icon = nativeImage.createFromPath(templatePath);
    if (!icon.isEmpty()) {
      icon.setTemplateImage(true);
      return icon;
    }
  }

  const fullPath = path.join(iconDir, 'tray.png');
  let icon = nativeImage.createFromPath(fullPath);
  if (icon.isEmpty()) return nativeImage.createEmpty();
  icon = icon.resize({ width: 16, height: 16 });
  return icon;
}

export function createTray(): void {
  if (tray) return;
  try {
    const icon = getTrayIcon();
    tray = new Tray(icon);
    tray.setToolTip('Gnosis');

    if (process.platform === 'darwin') {
      tray.setIgnoreDoubleClickEvents(true);
    }
  } catch (error) {
    console.error('[tray] Failed to create tray:', error);
  }
}

export interface TrayCallbacks {
  onShowWindow: () => void;
  onNavigateToReview: (reviewId: string) => void;
  onOpenExternal: (url: string) => void;
  onQuit: () => void;
}

// PR status cache — entries expire after 5 minutes
const PR_STATUS_TTL_MS = 5 * 60_000;
const prStatusCache = new Map<string, { status: PrStatus; fetchedAt: number }>();
const pendingFetches = new Set<string>();
let statusFetcher: ((prUrl: string) => Promise<PrStatus | null>) | null = null;
let lastReviews: ReviewHistoryEntry[] = [];
let lastCallbacks: TrayCallbacks | null = null;

export function setStatusFetcher(fetcher: (prUrl: string) => Promise<PrStatus | null>): void {
  statusFetcher = fetcher;
}

export function updateTrayMenu(
  reviews: ReviewHistoryEntry[],
  callbacks: TrayCallbacks,
): void {
  if (!tray) return;
  const { onShowWindow, onNavigateToReview, onOpenExternal, onQuit } = callbacks;

  const template: Electron.MenuItemConstructorOptions[] = [];

  // Active generations
  const generating = reviews.filter((r) => r.status === 'generating');
  if (generating.length > 0) {
    for (const gen of generating.slice(0, 4)) {
      template.push({
        label: `⏳ ${truncate(gen.prTitle, 40)}`,
        click: onShowWindow,
      });
    }
    template.push({ type: 'separator' });
  }

  // Recent reviews — deduplicate by PR URL, keeping the most recent per PR
  const seenPrUrls = new Set<string>();
  const recent = reviews
    .filter((r) => r.status === 'completed' || r.status === 'failed')
    .filter((r) => {
      if (seenPrUrls.has(r.prUrl)) return false;
      seenPrUrls.add(r.prUrl);
      return true;
    })
    .slice(0, MAX_MENU_REVIEWS);

  if (recent.length > 0) {
    template.push({ label: 'Recent Reviews', enabled: false });
    for (const review of recent) {
      if (review.status === 'failed') {
        template.push({
          label: `✕ ${truncate(review.prTitle, 45)}`,
          submenu: [
            { label: review.error ? truncate(review.error, 50) : 'Generation failed', enabled: false },
          ],
        });
        continue;
      }

      const cached = prStatusCache.get(review.prUrl);
      const cachedStatus = cached && (Date.now() - cached.fetchedAt < PR_STATUS_TTL_MS) ? cached.status : null;
      const unreadDot = review.unread ? '● ' : '';
      template.push({
        label: `${unreadDot}${truncate(review.prTitle, 45)}`,
        submenu: buildReviewSubmenu(
          review,
          cachedStatus,
          () => onNavigateToReview(review.id),
          () => onOpenExternal(review.prUrl),
          (url) => onOpenExternal(url),
        ),
      });
    }
    template.push({ type: 'separator' });
  }

  // App controls
  template.push({ label: 'Open Gnosis', click: onShowWindow });
  template.push({ type: 'separator' });
  template.push({ label: 'Quit Gnosis', click: onQuit });

  const contextMenu = Menu.buildFromTemplate(template);
  tray.setContextMenu(contextMenu);

  tray.removeAllListeners('click');
  tray.removeAllListeners('right-click');

  if (process.platform === 'darwin') {
    tray.on('click', () => tray?.popUpContextMenu());
    tray.on('right-click', () => tray?.popUpContextMenu());
  } else {
    tray.on('click', onShowWindow);
  }

  // Stash for rebuild after status fetch
  lastReviews = reviews;
  lastCallbacks = callbacks;

  // Fetch live PR status in background for open PRs
  if (statusFetcher) {
    const openReviews = recent.filter(
      (r) => {
        if (r.status !== 'completed' || r.prState !== 'open' || pendingFetches.has(r.prUrl)) return false;
        const cached = prStatusCache.get(r.prUrl);
        return !cached || Date.now() - cached.fetchedAt >= PR_STATUS_TTL_MS;
      },
    );
    if (openReviews.length > 0) {
      let resolved = 0;
      let didUpdate = false;
      for (const review of openReviews) {
        pendingFetches.add(review.prUrl);
        statusFetcher(review.prUrl)
          .then((status) => {
            if (status) {
              prStatusCache.set(review.prUrl, { status, fetchedAt: Date.now() });
              didUpdate = true;
            }
          })
          .catch(() => {})
          .finally(() => {
            pendingFetches.delete(review.prUrl);
            resolved++;
            if (resolved === openReviews.length && didUpdate && lastCallbacks) {
              updateTrayMenu(lastReviews, lastCallbacks);
            }
          });
      }
    }
  }
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
