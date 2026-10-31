import type { PrMetadata, ChangedFile, ProjectClaudeContext, TopicPlan } from './types';
import type { IndexedHunk } from './diff-parse';
import { normalizeDiagramBrief } from './diagram-spec';

const CHARS_PER_TOKEN = 4;
const MAX_TOKENS = 150_000;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;
const MAX_FILE_LINES = 200;

function truncateFileContent(content: string, maxLines: number): string {
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;
  return lines.slice(0, maxLines).join('\n') + `\n... [truncated after ${maxLines} lines]`;
}

/** Preserve nearby source with original line numbers instead of always showing the file's first 200 lines. */
function nearbyFileContent(content: string, hunks: IndexedHunk[], side: 'base' | 'head') {
  if (content.length <= 16_000) return content;
  const lines = content.split('\n');
  const selected = new Set<number>();
  for (const hunk of hunks) {
    const match = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk.expandedHunkHeader);
    if (!match) continue;
    const start = Number(match[side === 'base' ? 1 : 3]);
    const countText: string | undefined = match[side === 'base' ? 2 : 4];
    const count = Number(countText || 1);
    for (const anchor of [start, start + count])
      for (
        let i = Math.max(0, anchor - 16);
        i < Math.min(lines.length, anchor + 15) && selected.size < MAX_FILE_LINES;
        i++
      )
        selected.add(i);
  }
  let excerpt = 'Source excerpts near changed ranges (original line numbers; omitted regions are not empty):\n';
  for (const index of [...selected].sort((a, b) => a - b)) {
    const line = `${index + 1}: ${lines[index]}\n`;
    if (excerpt.length + line.length > 16_000) {
      excerpt += '[Further surrounding source omitted; see diff hunks.]';
      break;
    }
    excerpt += line;
  }
  return excerpt;
}

// Render the Claude-conventions block for the prompt. Returns empty
// string when there's nothing to include — callers can concatenate
// unconditionally. Omits inner tags with no content so the prompt
// isn't cluttered by empty envelopes.
function renderClaudeContextSection(ctx: ProjectClaudeContext | null | undefined): string {
  if (!ctx) return '';
  const parts: string[] = [];
  if (ctx.projectInstructions) {
    parts.push(`<project_instructions source="CLAUDE.md">\n${ctx.projectInstructions}\n</project_instructions>`);
  }
  if (ctx.commands.length > 0) {
    parts.push(
      '<custom_commands>\n' + ctx.commands.map((c) => `- /${c.name} — ${c.summary}`).join('\n') + '\n</custom_commands>'
    );
  }
  if (ctx.agents.length > 0) {
    parts.push(
      '<custom_agents>\n' + ctx.agents.map((a) => `- ${a.name} — ${a.summary}`).join('\n') + '\n</custom_agents>'
    );
  }
  if (ctx.skills.length > 0) {
    parts.push(
      '<custom_skills>\n' + ctx.skills.map((s) => `- ${s.name} — ${s.summary}`).join('\n') + '\n</custom_skills>'
    );
  }
  if (parts.length === 0) return '';
  return '<project_claude_context>\n' + parts.join('\n\n') + '\n</project_claude_context>';
}

export function buildContextPackage(
  prData: PrMetadata,
  expandedDiff: string,
  changedFiles: ChangedFile[],
  fileContents: Record<string, string>,
  headFileContents: Record<string, string>,
  neighborFiles: Record<string, string>,
  hunkIndex: string,
  excludedFilesSummary?: string,
  claudeContext?: ProjectClaudeContext | null
): string {
  const totalAdditions = changedFiles.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = changedFiles.reduce((s, f) => s + f.deletions, 0);

  const metaSection = `<pr_metadata>
Title: ${prData.title}
Author: ${prData.author}
Description: ${prData.description || '(no description)'}
Base branch: ${prData.baseBranch}
Files changed: ${changedFiles.length} | Lines added: ${totalAdditions} | Lines deleted: ${totalDeletions}
</pr_metadata>`;

  let claudeContextSection = renderClaudeContextSection(claudeContext);

  const diffSection = `<full_diff>
${expandedDiff}
</full_diff>`;

  const hunkIndexSection = hunkIndex;

  // Build file_contents (before) section
  let fileContentsSection = '<file_contents_before>\n';
  for (const [path, content] of Object.entries(fileContents)) {
    fileContentsSection += `  <file path="${path}">\n${content}\n  </file>\n`;
  }
  fileContentsSection += '</file_contents_before>';

  // Build file_contents_after (head) section
  let headContentsSection = '<file_contents_after>\n';
  for (const [path, content] of Object.entries(headFileContents)) {
    headContentsSection += `  <file path="${path}">\n${content}\n  </file>\n`;
  }
  headContentsSection += '</file_contents_after>';

  // Build neighbor_files section
  let neighborSection = '<neighbor_files>\n';
  for (const [path, content] of Object.entries(neighborFiles)) {
    neighborSection += `  <file path="${path}" relationship="imported by changed files">\n${content}\n  </file>\n`;
  }
  neighborSection += '</neighbor_files>';

  let diffStr = diffSection;
  let fileContentsStr = fileContentsSection;
  let headContentsStr = headContentsSection;
  let neighborStr = neighborSection;

  const excludedStr = excludedFilesSummary ?? '';

  function totalSize(): number {
    return (
      metaSection.length +
      (claudeContextSection ? claudeContextSection.length + 4 : 0) +
      excludedStr.length +
      4 +
      diffStr.length +
      4 +
      hunkIndexSection.length +
      4 +
      fileContentsStr.length +
      4 +
      headContentsStr.length +
      4 +
      neighborStr.length
    );
  }

  // Step 1: Drop neighbor files to fit budget
  if (totalSize() > MAX_CHARS) {
    const neighborBudget = Math.max(
      0,
      MAX_CHARS -
        metaSection.length -
        diffStr.length -
        hunkIndexSection.length -
        fileContentsStr.length -
        headContentsStr.length -
        20
    );
    let neighborChars = 0;
    const truncatedNeighbor: Record<string, string> = {};
    for (const [p, content] of Object.entries(neighborFiles)) {
      const entry = `  <file path="${p}" relationship="imported by changed files">\n${content}\n  </file>\n`;
      if (neighborChars + entry.length > neighborBudget) break;
      truncatedNeighbor[p] = content;
      neighborChars += entry.length;
    }
    neighborStr = '<neighbor_files>\n';
    for (const [p, content] of Object.entries(truncatedNeighbor)) {
      neighborStr += `  <file path="${p}" relationship="imported by changed files">\n${content}\n  </file>\n`;
    }
    neighborStr += '</neighbor_files>';
  }

  // Step 2: Truncate file contents to 200 lines each
  if (totalSize() > MAX_CHARS) {
    console.warn('[context-builder] Context too large — truncating file contents to 200 lines each');
    fileContentsStr = '<file_contents_before>\n';
    for (const [p, content] of Object.entries(fileContents)) {
      fileContentsStr += `  <file path="${p}">\n${truncateFileContent(content, MAX_FILE_LINES)}\n  </file>\n`;
    }
    fileContentsStr += '</file_contents_before>';

    headContentsStr = '<file_contents_after>\n';
    for (const [p, content] of Object.entries(headFileContents)) {
      headContentsStr += `  <file path="${p}">\n${truncateFileContent(content, MAX_FILE_LINES)}\n  </file>\n`;
    }
    headContentsStr += '</file_contents_after>';
  }

  // Step 3: Drop neighbor files entirely
  if (totalSize() > MAX_CHARS) {
    console.warn('[context-builder] Still too large — dropping neighbor files');
    neighborStr = '<neighbor_files>\n<!-- omitted: context budget exceeded -->\n</neighbor_files>';
  }

  // Step 3b: Drop the Claude project-context block. Small but not
  // load-bearing vs. the diff and file contents carrying the actual
  // review signal.
  if (totalSize() > MAX_CHARS && claudeContextSection) {
    console.warn('[context-builder] Still too large — dropping project Claude context');
    claudeContextSection = '';
  }

  // Step 4: Drop file contents entirely (keep only the diff)
  if (totalSize() > MAX_CHARS) {
    console.warn('[context-builder] Still too large — dropping file contents, keeping diff only');
    fileContentsStr = '<file_contents_before>\n<!-- omitted: context budget exceeded -->\n</file_contents_before>';
    headContentsStr = '<file_contents_after>\n<!-- omitted: context budget exceeded -->\n</file_contents_after>';
  }

  // Step 5: Truncate the diff itself as a last resort
  if (totalSize() > MAX_CHARS) {
    const overhead =
      metaSection.length +
      hunkIndexSection.length +
      fileContentsStr.length +
      headContentsStr.length +
      neighborStr.length +
      20;
    const diffBudget = MAX_CHARS - overhead;
    console.warn(
      `[context-builder] Diff too large (${expandedDiff.length} chars) — truncating to fit budget (${diffBudget} chars)`
    );
    const truncatedDiff = expandedDiff.slice(0, diffBudget);
    diffStr = `<full_diff>\n${truncatedDiff}\n... [truncated — diff exceeded context budget]\n</full_diff>`;
  }

  const finalPackage =
    metaSection +
    (claudeContextSection ? '\n\n' + claudeContextSection : '') +
    (excludedStr ? '\n\n' + excludedStr : '') +
    '\n\n' +
    diffStr +
    '\n\n' +
    hunkIndexSection +
    '\n\n' +
    fileContentsStr +
    '\n\n' +
    headContentsStr +
    '\n\n' +
    neighborStr;
  const estimatedTokens = Math.ceil(finalPackage.length / CHARS_PER_TOKEN);

  console.log(
    `[context-builder] Section sizes (chars): diff=${expandedDiff.length}, hunkIndex=${hunkIndexSection.length}, fileBefore=${fileContentsStr.length}, fileAfter=${headContentsStr.length}, neighbors=${neighborStr.length}`
  );
  console.log(
    `[context-builder] Total context: ${finalPackage.length} chars (~${estimatedTokens.toLocaleString()} tokens) | Budget: ${MAX_CHARS} chars (~${MAX_TOKENS.toLocaleString()} tokens)`
  );

  return finalPackage;
}

/**
 * Build a lightweight context string for the planner phase — only PR metadata and hunk index.
 */
export function buildPlannerContext(
  prData: PrMetadata,
  changedFiles: ChangedFile[],
  hunkIndex: string,
  excludedFilesSummary?: string,
  claudeContext?: ProjectClaudeContext | null
): string {
  const totalAdditions = changedFiles.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = changedFiles.reduce((s, f) => s + f.deletions, 0);

  let ctx = `<pr_metadata>
Title: ${prData.title}
Author: ${prData.author}
Description: ${prData.description || '(no description)'}
Base branch: ${prData.baseBranch}
Files changed: ${changedFiles.length} | Lines added: ${totalAdditions} | Lines deleted: ${totalDeletions}
</pr_metadata>`;

  const claudeSection = renderClaudeContextSection(claudeContext);
  if (claudeSection) ctx += '\n\n' + claudeSection;
  if (excludedFilesSummary) ctx += '\n\n' + excludedFilesSummary;
  ctx += '\n\n' + hunkIndex;

  return ctx;
}

/**
 * Build scoped context for a single topic's writer call — only the hunks and file contents
 * relevant to that topic.
 */
export function buildTopicContext(
  topic: TopicPlan,
  hunkMap: Map<string, IndexedHunk>,
  fileContents: Record<string, string>,
  headFileContents: Record<string, string>,
  neighborFiles: Record<string, string>,
  prTitle: string,
  prDescription: string,
  storyArc: string,
  allTopics: TopicPlan[],
  claudeContext?: ProjectClaudeContext | null
): string {
  const relevantHunks = topic.hunkIds.map((id) => hunkMap.get(id)).filter((h): h is IndexedHunk => h !== undefined);

  // Collect affected file paths
  const affectedFiles = new Set(relevantHunks.map((h) => h.filePath));

  // Build dependency context — briefs of topics this one depends on
  const depSet = new Set(topic.dependsOn);
  const depBriefs = allTopics
    .filter((t) => depSet.has(t.title))
    .map((t) => `- "${t.title}" (${t.slideType}): ${t.narrativeBrief}`)
    .join('\n');

  const brief = normalizeDiagramBrief(topic.diagramBrief);
  // Parallel writers share planned coverage, not claims about text already generated.
  const diagramPlan = allTopics
    .filter((other) => other.title !== topic.title)
    .flatMap((other) => {
      const planned = normalizeDiagramBrief(other.diagramBrief);
      if (!planned) return [];
      return [
        {
          topic: other.title,
          ...(typeof planned === 'string'
            ? { brief: planned.slice(0, 500) }
            : { question: planned.question, takeaway: planned.takeaway, essentialConcepts: planned.essentialConcepts }),
        },
      ];
    });
  const claudeSection = renderClaudeContextSection(claudeContext);
  let ctx = `<story_arc>${storyArc}</story_arc>

<narrative_brief>${topic.narrativeBrief}</narrative_brief>
<diagram_brief>${brief ? (typeof brief === 'string' ? brief : JSON.stringify(brief)) : 'No diagram planned. Omit it unless the source reveals a useful visual explanation.'}</diagram_brief>
${diagramPlan.length ? `\n<diagram_coverage_plan>Planned coverage in other topics, not completed explanations. Avoid re-teaching these questions. Verify all claims against your source; do not claim the reader has already seen a generated diagram.\n${JSON.stringify(diagramPlan)}\n</diagram_coverage_plan>\n` : ''}

${claudeSection ? claudeSection + '\n\n' : ''}${depBriefs ? `<prior_topics>\nThis slide builds on:\n${depBriefs}\n</prior_topics>\n\n` : ''}<topic>
Title: ${topic.title}
Type: ${topic.slideType}
Importance: ${topic.importance}
PR: ${prTitle}
PR Description: ${prDescription || '(none)'}
</topic>

<diff_hunks>
`;
  for (const hunk of relevantHunks) {
    ctx += `--- ${hunk.filePath} (${hunk.fileStatus}) [${hunk.id}]\n`;
    ctx += `${hunk.expandedHunkHeader}\n`;
    ctx += `${hunk.expandedContent}\n\n`;
  }
  ctx += '</diff_hunks>';

  // Scoped file contents — only for affected files
  let hasBeforeContent = false;
  let beforeSection = '\n\n<file_contents_before>\n';
  for (const filePath of affectedFiles) {
    if (fileContents[filePath]) {
      beforeSection += `  <file path="${filePath}">\n${nearbyFileContent(
        fileContents[filePath],
        relevantHunks.filter((h) => h.filePath === filePath),
        'base'
      )}\n  </file>\n`;
      hasBeforeContent = true;
    }
  }
  beforeSection += '</file_contents_before>';
  if (hasBeforeContent) ctx += beforeSection;

  let hasAfterContent = false;
  let afterSection = '\n\n<file_contents_after>\n';
  for (const filePath of affectedFiles) {
    if (headFileContents[filePath]) {
      afterSection += `  <file path="${filePath}">\n${nearbyFileContent(
        headFileContents[filePath],
        relevantHunks.filter((h) => h.filePath === filePath),
        'head'
      )}\n  </file>\n`;
      hasAfterContent = true;
    }
  }
  afterSection += '</file_contents_after>';
  if (hasAfterContent) ctx += afterSection;

  // Scoped neighbor files — only imports relevant to affected files
  let hasNeighbors = false;
  let neighborSection = '\n\n<neighbor_files>\n';
  for (const [path, content] of Object.entries(neighborFiles)) {
    // Include neighbor if any affected file likely imports it
    const base = path.replace(/\.[^.]+$/, '');
    const isRelevant = [...affectedFiles].some(
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- file records can omit either revision at runtime
      (f) => fileContents[f]?.includes(base) || headFileContents[f]?.includes(base)
    );
    if (isRelevant) {
      neighborSection += `  <file path="${path}">\n${truncateFileContent(content, MAX_FILE_LINES)}\n  </file>\n`;
      hasNeighbors = true;
    }
  }
  neighborSection += '</neighbor_files>';
  if (hasNeighbors) ctx += neighborSection;

  return ctx;
}
