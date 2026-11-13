/**
 * "What the AI looked at" for chat answers.
 *
 * A trace records two kinds of evidence, and never mixes them up:
 * - `context`: what Gnosis itself put in the prompt (diff hunks, the file, the
 *   selection, the PR description, earlier messages). This is certain.
 * - `agent`: tool calls the AI CLI reported in its stream (Claude `tool_use`
 *   blocks, Codex `command_execution` and similar items).
 *
 * Steps are never inferred from the answer text. A trace with only context
 * steps is labelled "Context used", not "AI read".
 *
 * The compact chip and summary presentation is inspired by the Thinking and
 * Tool Chips components of Beautiful UI (https://www.beautifului.dev/, MIT).
 */
import type { DiffHunk, SendSlideChatRequest } from './types';

export type ChatTraceKind =
  | 'diff'
  | 'file'
  | 'selection'
  | 'pr'
  | 'history'
  | 'read'
  | 'search'
  | 'command'
  | 'edit'
  | 'web'
  | 'tool';

export interface ChatTraceStep {
  /** Stable within a trace: context steps derive it from their content, agent steps from the tool call id. */
  id: string;
  source: 'context' | 'agent';
  kind: ChatTraceKind;
  /** Short chip text, for example a file name or a search pattern. */
  label: string;
  /** Full text for the expanded list and accessible names. */
  detail?: string;
  /** Repository-relative path when the step points at a file in the PR. */
  path?: string;
  startLine?: number;
  endLine?: number;
  side?: 'before' | 'after';
}

export interface ChatTrace {
  steps: ChatTraceStep[];
}

/** A tool call as the provider stream reports it. `input` is the tool's own argument object. */
export interface AgentToolCall {
  id?: string;
  name: string;
  input?: Record<string, unknown>;
}

const MAX_STEPS = 60;
const MAX_TEXT = 300;
const clip = (text: string, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
export const baseName = (filePath: string) => filePath.split('/').filter(Boolean).at(-1) ?? filePath;

export function lineRangeText(step: Pick<ChatTraceStep, 'startLine' | 'endLine'>): string {
  if (!step.startLine) return '';
  return step.endLine && step.endLine !== step.startLine ? `L${step.startLine}–${step.endLine}` : `L${step.startLine}`;
}

/** Lines a unified diff hunk covers, from its `@@ -a,b +c,d @@` header. Pure deletions point at the old side. */
export function hunkLineRange(
  header: string
): { startLine: number; endLine: number; side: 'before' | 'after' } | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header.trim());
  if (!match) return undefined;
  // Optional regex groups are undefined at runtime; a missing count means one line.
  const [oldStart, oldCount, newStart, newCount] = [1, 2, 3, 4].map((i) =>
    Number((match[i] as string | undefined) ?? 1)
  );
  if (newCount > 0) return { startLine: newStart, endLine: newStart + newCount - 1, side: 'after' };
  if (oldCount > 0) return { startLine: oldStart, endLine: oldStart + oldCount - 1, side: 'before' };
  return undefined;
}

/** Selections from the Changes view begin with `After lines 40–52:`; topic selections carry no location. */
export function selectionStep(selection: string | undefined, path?: string): ChatTraceStep | undefined {
  if (!selection?.trim()) return undefined;
  const located = /^(Before|After) lines (\d+)[–-](\d+):/.exec(selection);
  const lines = selection.split('\n').length - (located ? 1 : 0);
  const start = located ? Math.min(Number(located[2]), Number(located[3])) : undefined;
  const end = located ? Math.max(Number(located[2]), Number(located[3])) : undefined;
  return {
    id: 'context:selection',
    source: 'context',
    kind: 'selection',
    label: path && located ? baseName(path) : 'Selected code',
    detail: `${lines} ${lines === 1 ? 'line' : 'lines'} you selected`,
    ...(path && located
      ? { path, startLine: start, endLine: end, side: located[1] === 'Before' ? 'before' : 'after' }
      : {}),
  } as ChatTraceStep;
}

function historyStep(count: number): ChatTraceStep | undefined {
  if (!count) return undefined;
  return {
    id: 'context:history',
    source: 'context',
    kind: 'history',
    label: `${count} earlier ${count === 1 ? 'message' : 'messages'}`,
    detail: 'Earlier messages in this conversation',
  };
}

/** Context a topic chat sends: exactly the fields `buildSlideChatUserMessage` puts in the prompt. */
export function slideChatTrace(
  req: Pick<SendSlideChatRequest, 'prDescription' | 'summary' | 'history' | 'diffContent'>,
  hunks: Pick<DiffHunk, 'filePath' | 'hunkHeader'>[],
  selection?: string
): ChatTrace {
  const steps: ChatTraceStep[] = [];
  const selected = selectionStep(selection);
  if (selected) steps.push(selected);
  if (req.diffContent)
    hunks.forEach((hunk, index) => {
      const range = hunkLineRange(hunk.hunkHeader);
      steps.push({
        id: `context:hunk:${index}:${hunk.filePath}`,
        source: 'context',
        kind: 'diff',
        label: baseName(hunk.filePath),
        detail: `Diff of ${hunk.filePath}${range ? ` ${range.side === 'before' ? 'old' : 'new'} lines ${range.startLine}–${range.endLine}` : ''}`,
        path: hunk.filePath,
        ...range,
      });
    });
  if (req.prDescription.trim() || req.summary.trim())
    steps.push({
      id: 'context:pr',
      source: 'context',
      kind: 'pr',
      label: 'PR description',
      detail: 'PR title, summary and description',
    });
  const history = historyStep(req.history.length);
  if (history) steps.push(history);
  return { steps };
}

/** Context a file chat sends, as assembled in the main process. */
export function fileChatTrace(input: {
  path: string;
  /** Content kind of each side, such as `text`, `image` or `lfs`. */
  before: string;
  after: string;
  truncated: boolean;
  selection?: string;
  description: string;
  historyCount: number;
}): ChatTrace {
  const steps: ChatTraceStep[] = [];
  const selected = selectionStep(input.selection, input.path);
  if (selected) steps.push(selected);
  const sides = [input.before === 'text' && 'before', input.after === 'text' && 'after'].filter(Boolean);
  steps.push({
    id: 'context:file',
    source: 'context',
    kind: 'file',
    label: baseName(input.path),
    detail: `${input.path} · ${sides.length === 2 ? 'before and after' : sides.length ? `${sides[0]} only` : 'no text content'}${input.truncated ? ' (first 120,000 characters of each side)' : ''}`,
    path: input.path,
  });
  if (input.description.trim())
    steps.push({
      id: 'context:pr',
      source: 'context',
      kind: 'pr',
      label: 'PR description',
      detail: 'PR title and description',
    });
  const history = historyStep(input.historyCount);
  if (history) steps.push(history);
  return { steps };
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
/** Absolute paths come from the agent's own checkout; only relative ones can name a PR file. */
const repoPath = (value: string | undefined) =>
  value && !value.startsWith('/') && !/^[a-z]:\\/i.test(value) ? value.replace(/^\.\//, '') : undefined;

/** Turn a reported tool call into a step. Unknown tools keep their name; nothing is guessed. */
export function toolCallStep(call: AgentToolCall, index = 0): ChatTraceStep {
  const input = call.input ?? {};
  const id = `agent:${call.id ?? `${index}:${call.name}`}`;
  const base = { id, source: 'agent' as const };
  switch (call.name) {
    case 'Read': {
      const file = text(input.file_path) ?? '';
      const offset = count(input.offset);
      const limit = count(input.limit);
      const startLine = offset;
      const endLine = offset && limit ? offset + limit - 1 : undefined;
      return {
        ...base,
        kind: 'read',
        label: baseName(file) || 'file',
        detail: `Read ${clip(file)}`,
        path: repoPath(file),
        startLine,
        endLine,
      };
    }
    case 'Grep':
    case 'Glob': {
      const pattern = clip(text(input.pattern) ?? '', 80);
      const where = text(input.path) ?? text(input.glob);
      return {
        ...base,
        kind: 'search',
        label: `“${pattern}”`,
        detail: `${call.name === 'Grep' ? 'Searched for' : 'Listed files matching'} “${pattern}”${where ? ` in ${clip(where, 120)}` : ''}`,
      };
    }
    case 'Bash':
      return {
        ...base,
        kind: 'command',
        label: clip(text(input.command) ?? 'command', 60),
        detail: `Ran ${clip(text(input.command) ?? '')}`,
      };
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const file = text(input.file_path) ?? text(input.notebook_path) ?? '';
      return {
        ...base,
        kind: 'edit',
        label: baseName(file) || 'file',
        detail: `Edited ${clip(file)}`,
        path: repoPath(file),
      };
    }
    case 'WebSearch':
      return {
        ...base,
        kind: 'web',
        label: `“${clip(text(input.query) ?? '', 60)}”`,
        detail: `Searched the web for “${clip(text(input.query) ?? '')}”`,
      };
    case 'WebFetch':
      return {
        ...base,
        kind: 'web',
        label: clip(text(input.url) ?? 'page', 60),
        detail: `Fetched ${clip(text(input.url) ?? '')}`,
      };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(call.name);
  const name = mcp ? `${mcp[1]} · ${mcp[2]}` : call.name;
  return { ...base, kind: 'tool', label: clip(name, 60), detail: `Used ${clip(name)}` };
}

/** Codex `exec --json` items that represent work, not messages. */
export function codexItemToolCall(item: Record<string, unknown>): AgentToolCall | undefined {
  const id = text(item.id);
  switch (item.type) {
    case 'command_execution':
      return { id, name: 'Bash', input: { command: text(item.command) ?? '' } };
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const first = changes.find(
        (c): c is { path: string } => !!c && typeof c === 'object' && typeof (c as { path?: unknown }).path === 'string'
      );
      return { id, name: 'Edit', input: { file_path: first?.path ?? '' } };
    }
    case 'mcp_tool_call':
      return { id, name: `mcp__${text(item.server) ?? 'mcp'}__${text(item.tool) ?? 'tool'}` };
    case 'web_search':
      return { id, name: 'WebSearch', input: { query: text(item.query) ?? '' } };
  }
  return undefined;
}

export function appendTraceSteps(trace: ChatTrace | undefined, steps: ChatTraceStep[]): ChatTrace {
  const existing = trace?.steps ?? [];
  const ids = new Set(existing.map((s) => s.id));
  const added = steps.filter((s) => {
    if (ids.has(s.id)) return false;
    ids.add(s.id);
    return true;
  });
  if (!added.length && trace) return trace;
  return { steps: [...existing, ...added].slice(0, MAX_STEPS) };
}

export function traceLabel(trace: ChatTrace): string {
  return trace.steps.some((s) => s.source === 'agent') ? 'What the AI looked at' : 'Context used';
}

/** One-line count, in the spirit of "4 tool calls, 2 messages". */
export function traceCountText(trace: ChatTrace): string {
  const agent = trace.steps.filter((s) => s.source === 'agent').length;
  const context = trace.steps.length - agent;
  return [
    agent && `${agent} tool ${agent === 1 ? 'call' : 'calls'}`,
    context && `${context} ${context === 1 ? 'source' : 'sources'}`,
  ]
    .filter(Boolean)
    .join(', ');
}

const KINDS = new Set<ChatTraceKind>([
  'diff',
  'file',
  'selection',
  'pr',
  'history',
  'read',
  'search',
  'command',
  'edit',
  'web',
  'tool',
]);
const line = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

/** Validate a trace read back from storage. Malformed steps are dropped, never repaired into claims. */
export function parseChatTrace(value: unknown): ChatTrace | undefined {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { steps?: unknown }).steps)) return undefined;
  const steps = (value as { steps: unknown[] }).steps
    .flatMap((raw): ChatTraceStep[] => {
      if (!raw || typeof raw !== 'object') return [];
      const s = raw as Record<string, unknown>;
      if (
        typeof s.id !== 'string' ||
        typeof s.label !== 'string' ||
        (s.source !== 'context' && s.source !== 'agent') ||
        !KINDS.has(s.kind as ChatTraceKind)
      )
        return [];
      const step: ChatTraceStep = { id: s.id, source: s.source, kind: s.kind as ChatTraceKind, label: clip(s.label) };
      if (typeof s.detail === 'string') step.detail = clip(s.detail);
      if (typeof s.path === 'string') step.path = s.path;
      if (line(s.startLine)) step.startLine = line(s.startLine);
      if (line(s.endLine)) step.endLine = line(s.endLine);
      if (s.side === 'before' || s.side === 'after') step.side = s.side;
      return [step];
    })
    .slice(0, MAX_STEPS);
  return steps.length ? { steps } : undefined;
}
