/** Replay a saved review's code through the current planner/writers without GitHub or app-state writes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildExplanationSource, refineExplanationText } from '../lib/review-refinement';
import { getProvider } from '../lib/provider';
import { planReview, generateSlide, finalizeReviewOverview } from '../lib/agent';
import { buildPlannerContext, buildTopicContext } from '../lib/context-builder';
import { formatHunkIndexForPrompt, sortDiffHunks, type IndexedHunk } from '../lib/diff-parse';
import { DEFAULT_CODEX_MODEL, normalizeModelSelection } from '../lib/models';
import { normalizeEffort } from '../lib/effort';
import type { ChangedFile, PrMetadata, ReviewGuide, WriterSlideOutput } from '../lib/types';

async function main() {
  const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const reviewPath = arg('review');
  const outputPath = arg('output');
  if (!process.argv.includes('--live') || !reviewPath || !outputPath) {
    console.log(
      'Usage: npx tsx scripts/evaluate-chapters.ts --live --review=/path/to/saved.json --output=/private/output --provider=codex --model=gpt-6.1-sol --effort=high'
    );
    return;
  }
  const review = JSON.parse(await fs.readFile(reviewPath, 'utf8')) as ReviewGuide;
  const output = path.resolve(outputPath);
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const { provider, model } = normalizeModelSelection(arg('provider') ?? 'codex', arg('model') ?? DEFAULT_CODEX_MODEL);
  const effort = normalizeEffort(provider, model, arg('effort'), false);
  const source = sortDiffHunks(review.slides.flatMap((slide) => slide.diffHunks));
  const seen = new Set<string>();
  const hunks: IndexedHunk[] = [];
  for (const hunk of source) {
    const identity = JSON.stringify([hunk.filePath, hunk.hunkHeader, hunk.content]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const status = review.changedFiles?.find((file) => file.filename === hunk.filePath)?.status ?? 'modified';
    hunks.push({
      ...hunk,
      id: `hunk-${hunks.length}`,
      fileStatus: status,
      expandedHunkHeader: hunk.hunkHeader,
      expandedContent: hunk.content,
      additions: hunk.content.split('\n').filter((line) => line.startsWith('+')).length,
      deletions: hunk.content.split('\n').filter((line) => line.startsWith('-')).length,
      scopeName: /@@.*?@@\s*(.*)/.exec(hunk.hunkHeader)?.[1] || null,
    });
  }
  const metadata = {
    title: review.prTitle,
    description: review.prDescription,
    author: review.author,
    baseBranch: 'saved base',
    baseSha: review.baseSha,
    headSha: review.headSha,
  } as PrMetadata;
  const files = (review.changedFiles ?? []).map((file) => ({ ...file, patch: '' })) as ChangedFile[];
  const index = formatHunkIndexForPrompt(hunks);
  const context = buildPlannerContext(metadata, files, index, undefined, review.projectClaudeContext, hunks);
  const save = (name: string, value: unknown) =>
    fs.writeFile(path.join(output, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  await save('before.json', review);
  await fs.writeFile(path.join(output, 'planner-input.txt'), context, { mode: 0o600 });
  console.log(`Planning ${review.prTitle}: ${hunks.length} hunks, ${model}, ${effort} effort`);
  const signal = AbortSignal.timeout(15 * 60_000);
  // Reuse saved writers to isolate the editor's effect without another paid generation.
  const reuse = arg('reuse-writers');
  if (reuse) {
    const previous = JSON.parse(await fs.readFile(path.join(reuse, 'before.json'), 'utf8')) as ReviewGuide;
    if (previous.prUrl !== review.prUrl || previous.headSha !== review.headSha || previous.baseSha !== review.baseSha)
      throw Error('Reused writers must belong to the same PR and saved revision.');
  }
  const plan: Awaited<ReturnType<typeof planReview>> = reuse
    ? (JSON.parse(await fs.readFile(path.join(reuse, 'plan.json'), 'utf8')) as Awaited<ReturnType<typeof planReview>>)
    : await planReview(index, context, provider, model, undefined, false, signal, { effort });
  await save('plan.json', plan);
  const topics = [...plan.topics].sort((a, b) => a.order - b.order);
  const assignments = topics.flatMap((topic) => topic.hunkIds);
  const duplicate = assignments.filter((id, i) => assignments.indexOf(id) !== i);
  const unknown = assignments.filter((id) => !hunks.some((hunk) => hunk.id === id));
  const unassigned = hunks.filter((hunk) => !assignments.includes(hunk.id)).map((hunk) => hunk.id);
  await save('coverage.json', { totalHunks: hunks.length, duplicate, unknown, unassigned });
  console.log(
    'Chapters:',
    topics.map((topic) => topic.title)
  );
  console.log('Coverage:', { duplicate, unknown, unassigned });
  if (duplicate.length || unknown.length)
    throw Error('Invalid hunk assignments; inspect the saved plan before writing.');
  const map = new Map(hunks.map((hunk) => [hunk.id, hunk]));
  const after: { title: string; hunkIds: string[]; output: WriterSlideOutput }[] = [];
  // Bound concurrency while preserving each finished chapter if a later call fails.
  for (let start = 0; start < topics.length; start += 2) {
    const batch = await Promise.all(
      topics.slice(start, start + 2).map(async (topic, offset) => {
        const topicContext = buildTopicContext(
          topic,
          map,
          {},
          {},
          {},
          review.prTitle,
          review.prDescription,
          plan.storyArc,
          topics,
          review.projectClaudeContext
        );
        const draft = reuse
          ? (JSON.parse(
              await fs.readFile(path.join(reuse, `chapter-${start + offset + 1}-draft.json`), 'utf8')
            ) as WriterSlideOutput)
          : await generateSlide({
              providerName: provider,
              model,
              effort,
              topicContext,
              signal,
              reviewSuggestions: false,
              instructions:
                'This evaluation compares chapter grouping and prose only. Return svgIllustration, mechanism, d2Diagram, and explainerIdea as null. Use only the supplied saved-source evidence; do not use tools or add a diagram description.',
            });
        await save(`chapter-${start + offset + 1}-draft.json`, draft);
        const item = { title: draft.title ?? topic.title, hunkIds: topic.hunkIds, output: draft };
        await save(`chapter-${start + offset + 1}.json`, item);
        console.log(`Finished: ${item.title}`);
        return item;
      })
    );
    after.push(...batch);
  }
  const edited = await refineExplanationText({
    drafts: after.map((item) => item.output),
    source: buildExplanationSource(hunks),
    model,
    effort,
    signal,
    generate: async (options) => {
      const response = await getProvider(provider).generate(options);
      await save('edit-response.json', response);
      return response;
    },
  });
  for (let index = 0; index < after.length; index++) {
    after[index].output = edited[index];
    await save(`chapter-${index + 1}.json`, after[index]);
  }
  const summary = await finalizeReviewOverview({
    providerName: provider,
    model,
    effort,
    signal,
    title: review.prTitle,
    draft: plan.summary,
    riskRationale: plan.riskRationale,
    topics: after.map((item) => ({ title: item.title, narrative: item.output.narrative })),
  });
  await save('after.json', {
    model,
    effort,
    sourceReview: arg('review'),
    sourceHead: review.headSha,
    plan,
    summary,
    chapters: after,
  });
  const section = (title: string, narrative: string) => `### ${title}\n\n${narrative}\n`;
  const report = `# Chapter comparison: ${review.prTitle}\n\nSource: ${review.prUrl} at ${review.headSha}.\n\nNew run: ${model}, ${effort} effort. Replays saved diff hunks only; full file/neighbor context is unavailable. Diagrams are disabled for this text comparison. Original saved review is unchanged. This is a qualitative example, not a controlled performance benchmark.\n\n## Before (${review.slides.length} chapters)\n\n${review.summary}\n\n${review.slides.map((slide) => section(slide.title, slide.narrative)).join('\n')}\n## After (${after.length} chapters)\n\n${summary}\n\n${after.map((item) => section(item.title, item.output.narrative)).join('\n')}\n## Source coverage\n\n${assignments.length} of ${hunks.length} saved hunks assigned. Unassigned hunks remain available in the saved source; the app shows them as Other changes.\n`;
  await fs.writeFile(path.join(output, 'comparison.md'), report, { mode: 0o600 });
  console.log(`Comparison saved to ${path.join(output, 'comparison.md')}`);
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
