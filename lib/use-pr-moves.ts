import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { inspectionData } from './inspection-cache';
import { fileRevisionKey, type InspectionRevision, type PrChanges } from './pr-changes';
import { currentChanges } from './moved-symbols-plan';
import { codeIntelligenceSettings } from './code-intelligence';
import { useMovesPrefetch, type SyntaxFile } from './use-syntax-contents';

/**
 * Moved and renamed symbols (#398) for a PR workspace's members, whichever tab is open: Changes, an Explanation topic
 * or a Summary code thread all show the same notes (AGENTS.md, diff parity). Each member's changed files are tracked
 * from its current file list, read once in the background if no view has read it, and their contents are read for
 * moves as Changes' scope prefetch would (lib/use-syntax-contents.ts `useMovesPrefetch`). Nothing is tracked or read
 * until the preferences are loaded, nor while code intelligence is off.
 */
export function usePrMoves(members: readonly InspectionRevision[], preferences: unknown) {
  const owner = useId();
  const version = useSyncExternalStore(inspectionData.subscribe, inspectionData.getVersion);
  const settings = useMemo(() => codeIntelligenceSettings(preferences), [preferences]);
  const on = preferences !== null && preferences !== undefined && settings.enabled;
  const revisions = members.map((member) => `${member.url}\u0000${member.baseSha}\u0000${member.headSha}`).join('\n');
  // File lists this hook read itself, by member revision: the one read for a member is tracked, whatever base GitHub
  // gave it, and never read again.
  const [read, setRead] = useState<ReadonlyMap<string, PrChanges>>(new Map());
  const revisionKey = (member: InspectionRevision) => `${member.url}\u0000${member.headSha}`;
  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    for (const member of members) {
      if (currentChanges(member, inspectionData.peekChanges) || read.has(revisionKey(member))) continue;
      void inspectionData.readChanges(member, false, true).then(
        (snapshot) => {
          if (!cancelled && snapshot.metadata.headSha === member.headSha)
            setRead((known) => new Map(known).set(revisionKey(member), snapshot));
        },
        () => {}
      );
    }
    return () => {
      cancelled = true;
    };
  }, [revisions, on]);
  const files = useMemo((): SyntaxFile[] => {
    if (!on) return [];
    const result: SyntaxFile[] = [];
    for (const member of members) {
      const snapshot = currentChanges(member, inspectionData.peekChanges) ?? read.get(revisionKey(member));
      if (!snapshot) continue;
      for (const file of snapshot.files)
        result.push({
          key: fileRevisionKey(snapshot.url, file.path, snapshot.metadata.baseSha, snapshot.metadata.headSha),
          snapshot,
          file,
        });
    }
    return result;
  }, [revisions, version, on, read]);
  useMovesPrefetch(owner, files, settings);
}
