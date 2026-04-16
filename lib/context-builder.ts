import type { PrMetadata, ChangedFile, TopicPlan } from './types';
import type { IndexedHunk } from './diff-parse';

const CHARS_PER_TOKEN = 4;
const MAX_TOKENS = 150_000;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;
const MAX_FILE_LINES = 200;

function truncateFileContent(content: string, maxLines: number): string {
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;
  return lines.slice(0, maxLines).join('\n') + `\n... [truncated after ${maxLines} lines]`;
}

export function buildContextPackage(
  prData: PrMetadata,
  expandedDiff: string,
  changedFiles: ChangedFile[],
  fileContents: Record<string, string>,
  headFileContents: Record<string, string>,
  neighborFiles: Record<string, string>,
  hunkIndex: string,
  excludedFilesSummary?: string
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
): string {
  const relevantHunks = topic.hunkIds
    .map((id) => hunkMap.get(id))
    .filter((h): h is IndexedHunk => h !== undefined);

  // Collect affected file paths
  const affectedFiles = new Set(relevantHunks.map((h) => h.filePath));

  // Build dependency context — briefs of topics this one depends on
  const depSet = new Set(topic.dependsOn);
  const depBriefs = allTopics
    .filter((t) => depSet.has(t.title))
    .map((t) => `- "${t.title}" (${t.slideType}): ${t.narrativeBrief}`)
    .join('\n');

  let ctx = `<story_arc>${storyArc}</story_arc>

<narrative_brief>${topic.narrativeBrief}</narrative_brief>

${depBriefs ? `<prior_topics>\nThis slide builds on:\n${depBriefs}\n</prior_topics>\n\n` : ''}<topic>
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
      beforeSection += `  <file path="${filePath}">\n${truncateFileContent(fileContents[filePath], MAX_FILE_LINES)}\n  </file>\n`;
      hasBeforeContent = true;
    }
  }
  beforeSection += '</file_contents_before>';
  if (hasBeforeContent) ctx += beforeSection;

  let hasAfterContent = false;
  let afterSection = '\n\n<file_contents_after>\n';
  for (const filePath of affectedFiles) {
    if (headFileContents[filePath]) {
      afterSection += `  <file path="${filePath}">\n${truncateFileContent(headFileContents[filePath], MAX_FILE_LINES)}\n  </file>\n`;
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
      (f) => fileContents[f]?.includes(base) || headFileContents[f]?.includes(base),
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
