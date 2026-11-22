import { useEffect, useState } from 'react';
import type { PushedUpdate } from './conflict-undo';

/**
 * Your conflict update while its merge commit is this PR head (#445 item 25), for the header's "Merged main into this
 * PR · Undo this update". Read again when main says the PR's conflict state changed.
 */
export function useConflictPushed(url: string, headSha: string, enabled: boolean): PushedUpdate | undefined {
  const [pushed, setPushed] = useState<{ key: string; value: PushedUpdate | undefined }>();
  const key = `${url}@${headSha}`;
  useEffect(() => {
    if (!enabled || !url.startsWith('https://github.com/') || !/^[a-f0-9]{40,64}$/.test(headSha)) return;
    let live = true;
    const read = () =>
      window.electronAPI.conflictPushed(url, headSha).then(
        (value) => {
          if (live) setPushed({ key, value: value ?? undefined });
        },
        // An older main process, or a test without the handler: no line.
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
  }, [key, enabled]);
  return enabled && pushed?.key === key ? pushed.value : undefined;
}
