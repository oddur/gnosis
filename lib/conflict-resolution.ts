export interface ConflictFile {
  path: string;
  mode: string;
  base: string;
  ours: string;
  theirs: string;
  original: string;
  result: string;
  /** Human review acknowledgement; marker-free proposals alone are not reviewed. */
  resolved: boolean;
  source: 'manual' | 'mergiraf' | 'agent' | 'rerere';
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
  dependents?: string[];
  restack?: RestackPlan;
}
export interface RestackPlan {
  token: string;
  status: 'prepared' | 'blocked' | 'published';
  rootSha: string;
  expected: { url: string; headSha: string; baseSha: string; headBranch: string; baseBranch: string }[];
  branches: {
    url: string;
    title: string;
    repo: string;
    branch: string;
    baseBranch: string;
    baseRepo: string;
    oldSha: string;
    newSha: string;
    baseSha: string;
    commits: number;
    reused: number;
    patch: string;
    files: import('@pierre/diffs').FileDiffMetadata[];
  }[];
  blocked?: { url: string; title: string; reason: string; paths: string[]; files: ConflictFile[]; reused: number };
}
export type ConflictRequest =
  | { kind: 'open'; url: string; restart?: boolean }
  | { kind: 'save'; id: string; version: number; path: string; contents: string; resolved: boolean }
  | { kind: 'resolve'; id: string; version: number; engine: 'mergiraf' | 'agent'; path?: string; instructions?: string }
  | { kind: 'preview'; id: string; version: number }
  | { kind: 'publish'; id: string; version: number; previewToken: string; message: string }
  | { kind: 'discard'; id: string; version: number }
  | { kind: 'restack-prepare'; id: string; version: number }
  | { kind: 'restack-continue'; id: string; version: number }
  | { kind: 'restack-save'; id: string; version: number; path: string; contents: string; resolved: boolean }
  | { kind: 'restack-publish'; id: string; version: number; previewToken: string; reviewed: string[] };
export interface ConflictReply {
  session: ConflictSession;
  preview?: { patch: string; token: string; validation: string; files: import('@pierre/diffs').FileDiffMetadata[] };
}
export const CONFLICT_FILE_LIMIT = 1024 * 1024;
export function hasConflictMarkers(text: string) {
  return /^(?:<{7,}|={7,}|>{7,}|\|{7,})(?:\s|$)/m.test(text);
}

export type ConflictFileStage = 'conflicted' | 'resolved' | 'reviewed';
/** Derive the stage from the displayed draft, including edits not saved yet. */
export function conflictFileStage(file: ConflictFile, contents = file.result): ConflictFileStage {
  if (file.unsupported || hasConflictMarkers(contents)) return 'conflicted';
  return file.resolved && contents === file.result ? 'reviewed' : 'resolved';
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
    (r.kind === 'save' || r.kind === 'restack-save') &&
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
  if (r.kind === 'preview' || r.kind === 'discard' || r.kind === 'restack-prepare' || r.kind === 'restack-continue')
    return;
  if (
    r.kind === 'restack-publish' &&
    text('previewToken', 64) &&
    Array.isArray(r.reviewed) &&
    r.reviewed.length <= 30 &&
    r.reviewed.every((value) => typeof value === 'string' && value.length <= 2048)
  )
    return;
  if (r.kind === 'publish' && text('previewToken', 64) && text('message', 2000)) return;
  throw new Error('Invalid conflict operation.');
}
