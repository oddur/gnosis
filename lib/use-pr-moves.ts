import { useEffect, useId, useMemo, useSyncExternalStore } from 'react';
import { inspectionData } from './inspection-cache';
import { fileRevisionKey, type InspectionRevision } from './pr-changes';
import { codeIntelligenceSettings } from './code-intelligence';
import { useMovesPrefetch, type SyntaxFile } from './use-syntax-contents';

/**
 * Moved and renamed symbols (#398) for a PR workspace's members, whichever tab is open: Changes, an Explanation topic
 * or a Summary code thread all show the same notes (AGENTS.md, diff parity). Each member's changed files are tracked
 * from its file list, read in the background if no view has read it yet, and their contents are read for moves as
 * Changes' scope prefetch would (lib/use-syntax-contents.ts `useMovesPrefetch`).
 */
export function usePrMoves(members: readonly InspectionRevision[], preferences: unknown) {
  const owner = useId();
  const version = useSyncExternalStore(inspectionData.subscribe, inspectionData.getVersion);
  const revisions = members.map((member) => `${member.url}\u0000${member.baseSha}\u0000${member.headSha}`).join('\n');
  // A member whose file list no view has read yet is read in the background: Explanation alone shows notes too.
  useEffect(() => {
    for (const member of members)
      if (!inspectionData.peekChanges(member)) void inspectionData.readChanges(member, false, true).catch(() => {});
  }, [revisions]);
  const files = useMemo((): SyntaxFile[] => {
    const result: SyntaxFile[] = [];
    for (const member of members) {
      const snapshot = inspectionData.peekChanges(member);
      if (!snapshot || snapshot.metadata.headSha !== member.headSha) continue;
      for (const file of snapshot.files)
        result.push({
          key: fileRevisionKey(snapshot.url, file.path, snapshot.metadata.baseSha, snapshot.metadata.headSha),
          snapshot,
          file,
        });
    }
    return result;
  }, [revisions, version]);
  const settings = useMemo(() => codeIntelligenceSettings(preferences), [preferences]);
  useMovesPrefetch(owner, files, settings);
}
