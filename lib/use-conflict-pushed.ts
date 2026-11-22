import { useEffect, useState } from 'react';
import type { PushedUpdate } from './conflict-undo';

/**
 * Your conflict update while its merge commit is this PR head (#445 item 25), for the header's "Merged main into this
 * PR · Undo this update". Read again when the head changes: a push or an undo moves it.
 */
export function useConflictPushed(url: string, headSha: string, enabled: boolean): PushedUpdate | undefined {
  const [pushed, setPushed] = useState<{ key: string; value: PushedUpdate | undefined }>();
  const key = `${url}@${headSha}`;
  useEffect(() => {
    if (!enabled || !url.startsWith('https://github.com/') || !/^[a-f0-9]{40,64}$/.test(headSha)) return;
    let live = true;
    // An older main process, or a test without the handler: no line.
    void Promise.resolve(window.electronAPI.conflictPushed?.(url, headSha)).then(
      (value) => {
        if (live) setPushed({ key, value: value ?? undefined });
      },
      () => {}
    );
    return () => {
      live = false;
    };
  }, [key, enabled]);
  return enabled && pushed?.key === key ? pushed.value : undefined;
}
