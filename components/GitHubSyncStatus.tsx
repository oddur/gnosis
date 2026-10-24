import { Check, Clock, AlertCircle, RefreshCw } from 'lucide-react';
import type { WorkbenchQueue } from '../lib/workbench';
import { timeAgo } from '../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from './ui/tooltip';

export function GitHubSyncStatus({ sync, onRefresh }: { sync: WorkbenchQueue['sync']; onRefresh: () => void }) {
  if (!sync) return null;
  const checked = sync.checkedAt
    ? `Last checked ${timeAgo(new Date(sync.checkedAt).toISOString())}.`
    : 'Your saved queue remains available.';
  const paused = sync.status === 'paused';
  const error = sync.status === 'error';
  const Icon = paused ? Clock : error ? AlertCircle : sync.status === 'checking' ? RefreshCw : Check;
  const label = paused
    ? 'Updates paused'
    : error
      ? 'Update failed'
      : sync.status === 'checking'
        ? 'Checking GitHub'
        : sync.checkedAt
          ? `Checked ${timeAgo(new Date(sync.checkedAt).toISOString())}`
          : 'Not checked yet';
  const detail = paused
    ? `Preserving your GitHub allowance. ${sync.retryAt ? `Updates resume after ${new Date(sync.retryAt).toLocaleTimeString()}.` : 'Updates will resume automatically.'}`
    : error
      ? 'Could not check GitHub. Select to retry.'
      : sync.status === 'checking'
        ? 'Checking for changed PRs in the background.'
        : 'GitHub updates automatically while this window is visible. Select to check now.';
  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => {
              if (sync.status !== 'checking') onRefresh();
            }}
            aria-disabled={sync.status === 'checking'}
            className={`github-sync-status ${paused || error ? 'text-warning' : 'text-muted-foreground'}`}
            aria-label={`${label}. ${detail} ${checked}`}
          >
            <Icon size={14} aria-hidden="true" />
            <span>{label}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">
          {detail} {checked}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
