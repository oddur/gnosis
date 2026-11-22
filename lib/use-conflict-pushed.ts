import { useCallback, useEffect, useState } from 'react';
import type { PushedUpdate } from './conflict-undo';

/**
 * Your conflict update while its merge commit is this PR head (#445 item 25), for the header's "Merged main into this
 * PR · Undo this update". Read again when the head changes, and on `reread`: after an undo the saved draft changes
 * before GitHub's head does.
 */
export function useConflictPushed(
  url: string,
  headSha: string,
  enabled: boolean
): [PushedUpdate | undefined, () => void] {
  const [pushed, setPushed] = useState<{ key: string; value: PushedUpdate | undefined }>();
  const [reads, setReads] = useState(0);
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
  }, [key, enabled, reads]);
  const reread = useCallback(() => {
    // The cached line goes at once, so the action can't be pressed again while the read runs.
    setPushed(undefined);
    setReads((n) => n + 1);
  }, []);
  return [enabled && pushed?.key === key ? pushed.value : undefined, reread];
}
