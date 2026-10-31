export interface ConflictFile {
  path: string;
  mode: string;
  base: string;
  ours: string;
  theirs: string;
  original: string;
  result: string;
  resolved: boolean;
  source: 'manual' | 'mergiraf' | 'agent';
  explanation?: string;
  unsupported?: string;
}
export interface ConflictSession {
  id: string;
  account: string;
  url: string;
  title: string;
  headRepo: string;
  baseRepo: string;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  baseSha: string;
  tree: string;
  files: ConflictFile[];
  version: number;
  status: 'editing' | 'published';
  preparation?: 'conflicts' | 'clean-merge' | 'up-to-date';
  commitSha?: string;
  stale?: boolean;
}
export type ConflictRequest =
  | { kind: 'open'; url: string; restart?: boolean }
  | { kind: 'save'; id: string; version: number; path: string; contents: string; resolved: boolean }
  | { kind: 'resolve'; id: string; version: number; engine: 'mergiraf' | 'agent'; path?: string; instructions?: string }
  | { kind: 'preview'; id: string; version: number }
  | { kind: 'publish'; id: string; version: number; previewToken: string; message: string }
  | { kind: 'discard'; id: string; version: number };
export interface ConflictReply {
  session: ConflictSession;
  preview?: { patch: string; token: string; validation: string; files: import('@pierre/diffs').FileDiffMetadata[] };
}
export const CONFLICT_FILE_LIMIT = 1024 * 1024;
export function hasConflictMarkers(text: string) {
  return /^(?:<{7,}|={7,}|>{7,}|\|{7,})(?:\s|$)/m.test(text);
}

/** IPC is an untyped boundary even when renderer callers use TypeScript. */
export function validateConflictRequest(value: unknown): asserts value is ConflictRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid conflict operation.');
  const r = value as Record<string, unknown>;
  const text = (key: string, limit: number) =>
    typeof r[key] === 'string' && r[key].length <= limit && !r[key].includes('\0');
  if (r.kind === 'open') {
    if (
      !text('url', 2048) ||
      !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(r.url as string) ||
      (r.restart !== undefined && typeof r.restart !== 'boolean')
    )
      throw new Error('Choose a valid GitHub PR.');
    return;
  }
  if (
    !text('id', 64) ||
    !/^[a-f0-9]{64}$/.test(r.id as string) ||
    !Number.isSafeInteger(r.version) ||
    Number(r.version) < 1
  )
    throw new Error('Invalid conflict session.');
  if (
    r.kind === 'save' &&
    text('path', 4096) &&
    text('contents', CONFLICT_FILE_LIMIT) &&
    typeof r.resolved === 'boolean'
  )
    return;
  if (
    r.kind === 'resolve' &&
    ['agent', 'mergiraf'].includes(String(r.engine)) &&
    (r.path === undefined || text('path', 4096)) &&
    (r.instructions === undefined || text('instructions', 10000))
  )
    return;
  if (r.kind === 'preview' || r.kind === 'discard') return;
  if (r.kind === 'publish' && text('previewToken', 64) && text('message', 2000)) return;
  throw new Error('Invalid conflict operation.');
}
