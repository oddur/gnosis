import type { LfsPointer } from './git-lfs';
import type { CommitSelection } from './pr-commits';
import type { PrMetadata, Provider, ModelId } from './types';
export interface PrChangeFile {
  path: string;
  previousPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  changeId: string;
  patch?: string;
}
export interface PrChanges {
  stackComparison?: import('./stack-changes').StackComparison;
  /** Patches were omitted to bound inventory memory; all listed paths remain accessible. */
  patchesDeferred?: boolean;
  /** GitHub capped this inventory. Listed files remain usable, but this is not the whole change. */
  filesTruncated?: boolean;
  fileKinds?: Record<string, import('./file-kinds').FileKinds>;
  comparison?: CommitSelection;
  version: 1;
  url: string;
  metadata: PrMetadata;
  comparisonBase: string;
  files: PrChangeFile[];
  fetchedAt: number;
}
export interface PrFileRequest {
  stackComparison?: string;
  downloadLfs?: boolean;
  comparison?: CommitSelection;
  url: string;
  baseSha: string;
  headSha: string;
  path: string;
}
export interface InspectionRevision {
  url: string;
  baseSha: string;
  headSha: string;
}
/**
 * How a read is scheduled: `false` for the reader's own request, `true` for queue preparation, or `{ predicted }` for
 * a navigation prediction labelled by destination kind, such as `pr-tab:changes`.
 */
export type InspectionMode = boolean | { predicted: string };
/** User reads outrank predictions, which outrank queue preparation. A pending read is reused only by a lower rank. */
export const inspectionRank = (mode: InspectionMode = false) => (mode === false ? 2 : mode === true ? 0 : 1);
export interface InspectionLoadOptions {
  requestId?: string;
  background?: boolean;
  /** A navigation prediction, labelled by destination kind. Foreground, never interactive, predicted budget. */
  predicted?: string;
  revision?: Pick<InspectionRevision, 'baseSha' | 'headSha'>;
}
export type PrFileSide =
  | { kind: 'absent' }
  | { kind: 'text'; content: string }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'lfs'; pointer: LfsPointer };
export interface PrFileContents {
  lfs?: boolean;
  before: PrFileSide;
  after: PrFileSide;
}
export interface FileChatMessage {
  role: 'user' | 'assistant';
  content: string;
}
export interface FileChatRequest extends PrFileRequest {
  requestId?: string;
  question: string;
  selection?: string;
  history: FileChatMessage[];
  provider: Provider;
  model: ModelId;
  effort?: import('./effort').Effort;
}
export const changesRevision = (value: Pick<PrMetadata, 'baseSha' | 'headSha'>) => `${value.baseSha}:${value.headSha}`;
export const fileRevisionKey = (url: string, path: string, baseSha: string, headSha: string) =>
  JSON.stringify([url, path, baseSha, headSha]);

/** Zero changed lines alone is not proof: binary replacements also report zero. */
export function isUnchangedMove(file: PrChangeFile, contents?: PrFileContents): boolean {
  if (file.status !== 'renamed' || !file.previousPath || file.additions || file.deletions || !contents) return false;
  const { before, after } = contents;
  if (before.kind === 'text' && after.kind === 'text') return before.content === after.content;
  if (before.kind === 'image' && after.kind === 'image') return before.dataUrl === after.dataUrl;
  if (before.kind === 'lfs' && after.kind === 'lfs')
    return before.pointer.oid === after.pointer.oid && before.pointer.size === after.pointer.size;
  return false;
}
