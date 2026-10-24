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
  comparison?: CommitSelection;
  version: 1;
  url: string;
  metadata: PrMetadata;
  comparisonBase: string;
  files: PrChangeFile[];
  fetchedAt: number;
}
export interface PrFileRequest {
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
export interface InspectionLoadOptions {
  background?: boolean;
  revision?: Pick<InspectionRevision, 'baseSha' | 'headSha'>;
}
export type PrFileSide = { kind: 'absent' } | { kind: 'text'; content: string } | { kind: 'image'; dataUrl: string };
export interface PrFileContents {
  before: PrFileSide;
  after: PrFileSide;
}
export interface FileChatMessage {
  role: 'user' | 'assistant';
  content: string;
}
export interface FileChatRequest extends PrFileRequest {
  question: string;
  selection?: string;
  history: FileChatMessage[];
  provider: Provider;
  model: ModelId;
}
export const changesRevision = (value: Pick<PrMetadata, 'baseSha' | 'headSha'>) => `${value.baseSha}:${value.headSha}`;
export const fileRevisionKey = (url: string, path: string, baseSha: string, headSha: string) =>
  JSON.stringify([url, path, baseSha, headSha]);
