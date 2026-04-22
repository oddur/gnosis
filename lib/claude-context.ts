import type { ProjectClaudeContext } from './types';

// Probing `.claude/` + `CLAUDE.md` conventions is identical whether the
// content lives in a GitHub repo or on the local filesystem — the only
// variable is HOW you read files and list directories. This module
// codifies the shared probe and takes a small IO interface so each
// DiffSource can plug in its own reader.

export interface ClaudeContextIO {
  /** Return file contents as UTF-8, or null when the path doesn't exist. */
  readFile(path: string): Promise<string | null>;
  /** List immediate children of `path`, filtered by `kind`. Return full
   *  child paths (relative to the repo root), not just basenames. */
  listDir(path: string, kind: 'file' | 'dir'): Promise<string[]>;
}

const CLAUDE_MD_MAX_CHARS = 8 * 1024;
const CLAUDE_ENTRY_SUMMARY_CHARS = 240;

export interface ProbeOptions {
  /** Skip the review-relevance filter and the CLAUDE.md truncation. Use this
   *  when the agent has filesystem access — every skill/command is reachable
   *  anyway, and hiding entries or truncating the CLAUDE.md just forces the
   *  agent to rediscover them via tools. */
  unfiltered?: boolean;
}
const CLAUDE_PATHS = {
  md: 'CLAUDE.md',
  root: '.claude',
  commands: 'commands',
  agents: 'agents',
  skills: 'skills',
} as const;

// Prefers a front-matter `description:` field, then the first
// non-empty paragraph. Hard-truncated so a verbose file can't eat
// the context budget.
export function summariseClaudeEntry(content: string): string {
  const fmMatch = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  let body = content;
  if (fmMatch) {
    body = content.slice(fmMatch[0].length);
    const descMatch = /^description:\s*(.+)$/m.exec(fmMatch[1]);
    if (descMatch) {
      return descMatch[1].trim().slice(0, CLAUDE_ENTRY_SUMMARY_CHARS);
    }
  }
  const firstPara = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !p.startsWith('#'));
  return (firstPara ?? body.trim()).replace(/\s+/g, ' ').slice(0, CLAUDE_ENTRY_SUMMARY_CHARS);
}

function entryName(p: string): string {
  const base = p.split('/').pop() ?? p;
  return base.replace(/\.md$/, '');
}

// Whitelist of review-signal keywords. Expressed as an array so
// adding / removing a term doesn't risk breaking regex escaping or
// accidental alternation boundaries.
const CLAUDE_REVIEW_KEYWORDS = [
  'review', 'audit', 'lint', 'security', 'accessib', 'convention', 'coding\\s*style',
  'style\\s*guide', 'architecture', 'refactor', 'critique', 'invariant', 'contract',
  'type\\s*safety', 'quality', 'design\\s*(system|pattern|principle|quality)', 'correctness',
  'harden', 'simplify', 'polish', 'distill', 'normalize', 'responsive', 'a11y', 'performance',
  'optim', 'vulnerab', 'best\\s*practice', 'anti[- ]?pattern', 'testing', 'test\\s*strategy',
  'naming\\s*convention', 'frontend', 'ui\\s+(design|component)', 'visual', 'typograph',
];
const CLAUDE_REVIEW_POSITIVE = new RegExp(`\\b(${CLAUDE_REVIEW_KEYWORDS.join('|')})\\b`);
const CLAUDE_REVIEW_HARD_NEGATIVE = /\bmcp\b|\bapi[- ]?key\b/;

export function isReviewRelevantClaudeEntry(name: string, content: string): boolean {
  // Scan name + first 2 KB only — summaries are up top, and a pass
  // match buried 20 KB into a body isn't a trustworthy signal.
  const lower = (name + ' ' + content.slice(0, 2000)).toLowerCase();
  if (CLAUDE_REVIEW_HARD_NEGATIVE.test(lower)) return false;
  return CLAUDE_REVIEW_POSITIVE.test(lower);
}

async function fetchSummarisedEntries(
  io: ClaudeContextIO,
  paths: string[],
  filter: (name: string, content: string) => boolean = () => true,
): Promise<{ included: { name: string; summary: string }[]; droppedCount: number }> {
  const included: { name: string; summary: string }[] = [];
  let droppedCount = 0;
  const concurrency = 5;
  for (let i = 0; i < paths.length; i += concurrency) {
    const batch = paths.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (p) => {
        const content = await io.readFile(p);
        if (!content) return;
        const name = entryName(p);
        if (!filter(name, content)) {
          droppedCount += 1;
          return;
        }
        included.push({ name, summary: summariseClaudeEntry(content) });
      }),
    );
  }
  included.sort((a, b) => a.name.localeCompare(b.name));
  return { included, droppedCount };
}

export async function probeClaudeContext(
  io: ClaudeContextIO,
  opts: ProbeOptions = {},
): Promise<ProjectClaudeContext | null> {
  const unfiltered = opts.unfiltered ?? false;
  const entryFilter = unfiltered ? undefined : isReviewRelevantClaudeEntry;
  // First pass: CLAUDE.md + one listing of `.claude/` itself. Skips
  // the three subdir requests on repos that have no Claude setup.
  const [claudeMdRaw, claudeRootEntries] = await Promise.all([
    io.readFile(CLAUDE_PATHS.md),
    io.listDir(CLAUDE_PATHS.root, 'dir'),
  ]);

  const hasCommands = claudeRootEntries.some((p) => p.endsWith(`/${CLAUDE_PATHS.commands}`));
  const hasAgents = claudeRootEntries.some((p) => p.endsWith(`/${CLAUDE_PATHS.agents}`));
  const hasSkills = claudeRootEntries.some((p) => p.endsWith(`/${CLAUDE_PATHS.skills}`));
  const hasRoot = hasCommands || hasAgents || hasSkills;

  const [commandPaths, agentPaths, skillDirs] = await Promise.all([
    hasCommands
      ? io.listDir(`${CLAUDE_PATHS.root}/${CLAUDE_PATHS.commands}`, 'file').then((paths) => paths.filter((p) => p.endsWith('.md')))
      : Promise.resolve<string[]>([]),
    hasAgents
      ? io.listDir(`${CLAUDE_PATHS.root}/${CLAUDE_PATHS.agents}`, 'file').then((paths) => paths.filter((p) => p.endsWith('.md')))
      : Promise.resolve<string[]>([]),
    hasSkills
      ? io.listDir(`${CLAUDE_PATHS.root}/${CLAUDE_PATHS.skills}`, 'dir')
      : Promise.resolve<string[]>([]),
  ]);

  const hasAny = !!claudeMdRaw || hasRoot;
  if (!hasAny) return null;

  let projectInstructions: string | null = null;
  let projectInstructionsBytes: number | undefined;
  if (claudeMdRaw) {
    projectInstructionsBytes = Buffer.byteLength(claudeMdRaw, 'utf-8');
    // Unfiltered mode keeps the full CLAUDE.md — the agent will use the
    // guidance directly, and forcing it to Read() a truncated version back
    // wastes a tool call.
    projectInstructions =
      !unfiltered && claudeMdRaw.length > CLAUDE_MD_MAX_CHARS
        ? claudeMdRaw.slice(0, CLAUDE_MD_MAX_CHARS) + `\n\n… [truncated, original ${projectInstructionsBytes} bytes]`
        : claudeMdRaw;
  }

  const [cmdResult, agentResult, skillResult] = await Promise.all([
    fetchSummarisedEntries(io, commandPaths, entryFilter),
    fetchSummarisedEntries(io, agentPaths, entryFilter),
    fetchSummarisedEntries(
      io,
      skillDirs.map((d) => `${d}/SKILL.md`),
      entryFilter,
    ),
  ]);

  const totalDropped = cmdResult.droppedCount + agentResult.droppedCount + skillResult.droppedCount;
  if (totalDropped > 0) {
    console.log(
      `[claude-context] Filtered out ${totalDropped} non-review entries (commands: ${cmdResult.droppedCount}, agents: ${agentResult.droppedCount}, skills: ${skillResult.droppedCount})`,
    );
  }

  const postFilterHasAny =
    !!projectInstructions ||
    cmdResult.included.length > 0 ||
    agentResult.included.length > 0 ||
    skillResult.included.length > 0;
  if (!postFilterHasAny) return null;

  return {
    projectInstructions,
    projectInstructionsBytes,
    commands: cmdResult.included,
    agents: agentResult.included,
    skills: skillResult.included,
  };
}
