import { useSyncExternalStore } from 'react';
import { inspectionData } from './inspection-cache';
import { changedWorkflowFiles } from './github-access';
import type { InspectionRevision } from './pr-changes';

/**
 * The workflow files this PR revision changes, from the Changes inventory Gnosis already prepares when a PR opens.
 * No GitHub read of its own: undefined until that inventory is loaded.
 */
export function useWorkflowFiles(revision: InspectionRevision | undefined): string[] | undefined {
  useSyncExternalStore(inspectionData.subscribe, inspectionData.getVersion);
  return revision ? changedWorkflowFiles(inspectionData.peekChanges(revision), revision) : undefined;
}
