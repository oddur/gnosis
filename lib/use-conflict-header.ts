import { useEffect, useState } from 'react';
import type { ConflictHeader } from './conflict-header';

/**
 * The PR header's conflict line for this head (lib/conflict-header.ts), while GitHub reports conflicts. Main prepares
 * the PR's conflicts in the background when the line is first asked for, and says when it changes.
 */
export function useConflictHeader(url: string, headSha: string, conflicted: boolean): ConflictHeader | undefined {
  const [header, setHeader] = useState<{ key: string; value: ConflictHeader | undefined }>();
  const key = `${url}@${headSha}`;
  useEffect(() => {
    if (!conflicted || !url.startsWith('https://github.com/')) return;
    let live = true;
    const read = () =>
      window.electronAPI.conflictHeader(url, headSha).then(
        (value) => {
          if (live) setHeader({ key, value: value ?? undefined });
        },
        // An older main process, or a test without the handler: the header shows no line.
        () => {}
      );
    void read();
    const off = window.electronAPI.onConflictHeaderChanged((changed) => {
      if (changed === url) void read();
    });
    return () => {
      live = false;
      off();
    };
  }, [key, conflicted]);
  return conflicted && header?.key === key ? header.value : undefined;
}
