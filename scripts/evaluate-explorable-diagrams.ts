import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { generateSlide, planReview } from '../lib/agent';
import { DEFAULT_CODEX_MODEL } from '../lib/models';
import type { PlannerOutput } from '../lib/types';
import {
  ILLUSTRATION_PLANNER_DIRECTIVE,
  SVG_ILLUSTRATION_DIRECTIVE,
  SVG_EXPLORATION_DIRECTIVE,
  type SvgIllustration,
} from '../lib/svg-illustration';
import { ILLUSTRATION_CRITIC_PROMPT, type IllustrationRender } from '../lib/illustration-review';

const exec = promisify(execFile);
const runName = process.argv.find((a) => a.startsWith('--run='))?.slice(6) ?? 'initial';
if (!/^[a-zA-Z0-9-]+$/.test(runName)) throw new Error('Invalid evaluation run name');
const directory = path.resolve('docs/research/generated-architecture', runName);
const cases = [
  {
    id: 'pipeline',
    title: 'From source to guided review',
    filePath: 'lib/agent.ts',
    paths: ['src/main.ts', 'lib/agent.ts', 'lib/illustration-review.ts', 'src/explainer-validation.ts'],
    question:
      'In the parallel-review path, how do the planner, topic writers, isolated SVG renderer and educational critic cooperate to produce a source-grounded explanation? Orient the reader to responsibilities and handoffs. Show that a rejected visual can be omitted while prose survives. Focus on this architecture, not retry deadlines or every implementation branch.',
  },
  {
    id: 'priority',
    title: 'Shared work follows the reviewer',
    filePath: 'lib/github-scheduler.ts',
    paths: ['lib/github-scheduler.ts', 'lib/shared-read.ts', 'lib/github-client.ts'],
    question:
      'How do caller scope, shared work, and the scheduler cooperate so an interactive caller promotes existing work? Explain the connected responsibilities, not a numeric queue toy. Do not claim active requests are preempted or that this scheduler itself enforces rate limits.',
  },
  {
    id: 'cache',
    title: 'A cleared cache stays cleared',
    filePath: 'lib/pr-file-cache.ts',
    paths: ['lib/pr-file-cache.ts'],
    question:
      'How do a caller, the revision cache, and an asynchronous loader interact when clear() runs before a pending read completes? Explain who still receives the result and why the old completion cannot repopulate the cache. Show order and ownership; do not invent cancellation.',
  },
];

async function main() {
  if (!process.argv.includes('--live')) {
    console.log('Pass --live to generate with Codex and render in Docker. Build gnosis-browser-tests first.');
    return;
  }
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'prompts.json'),
    JSON.stringify(
      {
        model: DEFAULT_CODEX_MODEL,
        planner: ILLUSTRATION_PLANNER_DIRECTIVE,
        writer: SVG_ILLUSTRATION_DIRECTIVE,
        exploration: SVG_EXPLORATION_DIRECTIVE,
        critic: ILLUSTRATION_CRITIC_PROMPT,
      },
      null,
      2
    )
  );
  const { stdout: revision } = await exec('git', ['rev-parse', 'HEAD']);
  const selected = process.argv.find((a) => a.startsWith('--case='))?.slice(7);
  const feedbackPath = process.argv.find((a) => a.startsWith('--feedback-file='))?.slice(16);
  const feedback = feedbackPath ? await fs.readFile(feedbackPath, 'utf8') : '';
  const refineRun = process.argv.find((a) => a.startsWith('--refine-run='))?.slice(13);
  if (refineRun && !/^[a-zA-Z0-9-]+$/.test(refineRun)) throw new Error('Invalid refinement run name');
  const results = await Promise.allSettled(
    cases
      .filter((c) => !selected || selected === c.id)
      .map(async (item) => {
        const folder = path.join(directory, item.id);
        await fs.mkdir(folder, { recursive: true });
        const prior = refineRun
          ? (JSON.parse(
              await fs.readFile(
                path.join('docs/research/generated-architecture', refineRun, item.id, 'result.json'),
                'utf8'
              )
            ) as { revision: string; slide: { svgIllustration?: SvgIllustration | null } })
          : null;
        if (prior && prior.revision !== revision.trim())
          throw new Error('Refinement must use the same source revision');
        const editorial = feedback ? `\n<editorial_feedback>${feedback}</editorial_feedback>` : '';
        const files: Record<string, string> = Object.fromEntries(
          await Promise.all(
            item.paths.map(
              async (p) =>
                [p, (await exec('git', ['show', `${revision.trim()}:${p}`], { maxBuffer: 10_000_000 })).stdout] as const
            )
          )
        );
        const context =
          `Explain the supplied Gnosis source at ${revision.trim()}. This is an evaluation of current code, not a fabricated PR diff. Use exploration.change="context" metadata for existing components. This is not text to print on the diagram.\nQuestion: ${item.question}\n` +
          Object.entries(files)
            .map(
              ([name, code]) =>
                `<file path="${name}">\n${code
                  .split('\n')
                  .map((line, i) => ({ line, n: i + 1 }))
                  .filter(({ n }) =>
                    name === 'src/main.ts'
                      ? n >= 1960 && n <= 2055
                      : name === 'lib/agent.ts'
                        ? n >= 535 && n <= 745
                        : name === 'lib/illustration-review.ts'
                          ? n >= 60
                          : name === 'src/explainer-validation.ts'
                            ? n >= 65 && n <= 140
                            : name !== 'lib/github-client.ts' || (n >= 230 && n <= 245) || (n >= 505 && n <= 575)
                  )
                  .map(({ line, n }) => `${n}: ${line}`)
                  .join('\n')}\n</file>`
            )
            .join('\n');
        await fs.writeFile(
          path.join(folder, 'source.json'),
          JSON.stringify(
            { revision: revision.trim(), files, question: item.question, context, feedback, refineRun },
            null,
            2
          )
        );
        let attempt = 0;
        const validate = async (scene: SvgIllustration, signal?: AbortSignal): Promise<IllustrationRender> => {
          const n = ++attempt;
          const input = `candidate-${n}.json`,
            output = `render-${n}.json`;
          await fs.writeFile(path.join(folder, input), JSON.stringify(scene, null, 2));
          await new Promise<void>((resolve, reject) => {
            const child = spawn(
              'docker',
              [
                'run',
                '--rm',
                '--init',
                '--shm-size=2g',
                '--security-opt',
                'seccomp=unconfined',
                '-v',
                `${folder}:/evaluation`,
                'gnosis-browser-tests',
                'bash',
                '-c',
                `xvfb-run -a node scripts/render-illustration.mjs /evaluation/${input} /evaluation/${output}`,
              ],
              { signal }
            );
            let log = '';
            child.stdout.on('data', (chunk) => {
              log += String(chunk);
            });
            child.stderr.on('data', (chunk) => {
              log += String(chunk);
            });
            child.on('error', reject);
            child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(log.slice(-6000)))));
          });
          const render = JSON.parse(await fs.readFile(path.join(folder, output), 'utf8')) as IllustrationRender;
          for (const [i, image] of render.images.entries())
            await fs.writeFile(path.join(folder, `render-${n}-${i}.png`), Buffer.from(image.base64, 'base64'));
          // PNGs retain the evidence without committing duplicate base64 payloads.
          await fs.rm(path.join(folder, output));
          return render;
        };
        console.log(`Planning ${item.id}`);
        const plan =
          refineRun && process.argv.includes('--reuse-plan')
            ? (JSON.parse(
                await fs.readFile(
                  path.join('docs/research/generated-architecture', refineRun, item.id, 'plan.json'),
                  'utf8'
                )
              ) as PlannerOutput)
            : await planReview(
                `[hunk-0] ${context}`,
                'One coherent topic using hunk-0. Choose the visual form and altitude that best answers the supplied question. Do not inspect the environment.' +
                  editorial,
                'codex',
                DEFAULT_CODEX_MODEL,
                undefined,
                false,
                AbortSignal.timeout(300_000)
              );
        await fs.writeFile(path.join(folder, 'plan.json'), JSON.stringify(plan, null, 2));
        console.log(`Drawing ${item.id}: ${JSON.stringify(plan.topics[0]?.diagramBrief)}`);
        const slide = await generateSlide({
          providerName: 'codex',
          model: DEFAULT_CODEX_MODEL,
          topicContext: `${context}\n<diagram_brief>${JSON.stringify(plan.topics[0]?.diagramBrief)}</diagram_brief>${editorial}${prior?.slide.svgIllustration ? `\n<previous_illustration>${JSON.stringify(prior.slide.svgIllustration)}</previous_illustration>` : ''}\nUse source-linked exploration when the visual contains meaningful components or participants. Do not run tools.`,
          validateIllustration: validate,
          signal: AbortSignal.timeout(900_000),
        });
        const result = {
          id: item.id,
          title: item.title,
          filePath: item.filePath,
          code: files[item.filePath],
          files,
          slide,
          model: DEFAULT_CODEX_MODEL,
          revision: revision.trim(),
          generatedAt: new Date().toISOString(),
        };
        await fs.writeFile(path.join(folder, 'result.json'), JSON.stringify(result, null, 2));
        console.log(
          `${item.id}: ${slide.svgIllustration ? `${slide.svgIllustration.exploration?.kind ?? 'illustration'}, ${slide.svgIllustration.scenarios[0].frames.length} frames` : 'NO ACCEPTED VISUAL'}`
        );
        return result;
      })
  );
  const target = 'tests/fixtures/architecture-generated.json';
  const previous = JSON.parse(await fs.readFile(target, 'utf8')) as { id: string }[];
  const completed = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const accepted = completed.filter((r) => !!r.slide.svgIllustration);
  for (const r of results) if (r.status === 'rejected') console.error(r.reason);
  await fs.writeFile(
    target,
    JSON.stringify(
      previous
        .map((p) => accepted.find((c) => c.id === p.id) ?? p)
        .concat(accepted.filter((c) => !previous.some((p) => p.id === c.id))),
      null,
      2
    ) + '\n'
  );
  if (results.some((r) => r.status === 'rejected') || completed.some((r) => !r.slide.svgIllustration))
    process.exitCode = 1;
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
