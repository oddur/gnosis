import { Check, Clock, AlertCircle, RefreshCw } from 'lucide-react';
import type { WorkbenchQueue } from '../lib/workbench';
import { timeAgo } from '../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from './ui/tooltip';

export interface GitHubSyncStatusProps {
  sync: WorkbenchQueue['sync'];
  onRefresh: () => void;
}

export function GitHubSyncStatus({ sync, onRefresh }: GitHubSyncStatusProps) {
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
            className="github-sync-status"
            aria-label={`${label}. ${detail} ${checked}`}
            aria-disabled={sync.status === 'checking'}
            onClick={() => {
              if (sync.status !== 'checking') onRefresh();
            }}
          >
            <Icon size={16} aria-hidden="true" />
            <strong>GitHub sync</strong>
            <span className="github-sync-label">{label}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">
          {detail} {checked}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
