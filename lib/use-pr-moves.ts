import { useEffect, useId, useMemo, useSyncExternalStore } from 'react';
import { inspectionData } from './inspection-cache';
import { fileRevisionKey, type InspectionRevision } from './pr-changes';
import { currentChanges } from './moved-symbols-plan';
import { codeIntelligenceSettings } from './code-intelligence';
import { useMovesPrefetch, type SyntaxFile } from './use-syntax-contents';

/**
 * Moved and renamed symbols (#398) for a PR workspace's members, whichever tab is open: Changes, an Explanation topic
 * or a Summary code thread all show the same notes (AGENTS.md, diff parity). Each member's changed files are tracked
 * from its current file list, read in the background if no view has read it yet, and their contents are read for moves
 * as Changes' scope prefetch would (lib/use-syntax-contents.ts `useMovesPrefetch`). Nothing is tracked or read until
 * the preferences are loaded: code intelligence, or a language, may be off.
 */
export function usePrMoves(members: readonly InspectionRevision[], preferences: unknown) {
  const owner = useId();
  const version = useSyncExternalStore(inspectionData.subscribe, inspectionData.getVersion);
  const loaded = preferences !== null && preferences !== undefined;
  const revisions = members.map((member) => `${member.url}\u0000${member.baseSha}\u0000${member.headSha}`).join('\n');
  // A member whose current file list no view has read yet is read in the background: Explanation alone shows notes.
  useEffect(() => {
    if (!loaded) return;
    for (const member of members)
      if (!currentChanges(member, inspectionData.peekChanges))
        void inspectionData.readChanges(member, false, true).catch(() => {});
  }, [revisions, loaded]);
  const files = useMemo((): SyntaxFile[] => {
    if (!loaded) return [];
    const result: SyntaxFile[] = [];
    for (const member of members) {
      const snapshot = currentChanges(member, inspectionData.peekChanges);
      if (!snapshot) continue;
      for (const file of snapshot.files)
        result.push({
          key: fileRevisionKey(snapshot.url, file.path, snapshot.metadata.baseSha, snapshot.metadata.headSha),
          snapshot,
          file,
        });
    }
    return result;
  }, [revisions, version, loaded]);
  const settings = useMemo(() => codeIntelligenceSettings(preferences), [preferences]);
  useMovesPrefetch(owner, files, settings);
}
