import { useContext } from 'react';
import { PrReadContext } from '../lib/pr-read-context';
import { unreadDescription } from '../lib/pr-read-state';
import { TooltipProvider, Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

export function UnreadPrMarker({ urls }: { urls: string[] }) {
  const context = useContext(PrReadContext);
  const reasons = [...new Set(urls.flatMap((url) => context?.states[url]?.unread ?? []))];
  if (!reasons.length) return null;
  const label = unreadDescription(reasons);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="pr-unread-dot"
            role="img"
            aria-label={label}
            tabIndex={0}
            onClick={(event) => event.stopPropagation()}
          />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
