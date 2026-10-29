import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import electron from 'electron';
import { generateSlide, planReview } from '../lib/agent';
import { DEFAULT_CODEX_MODEL } from '../lib/models';
import { MECHANISM_CASES } from '../tests/fixtures/mechanism-examples';
import { reviewIllustration, type IllustrationRender } from '../lib/illustration-review';
import { getProvider } from '../lib/provider';
import type { SvgIllustration } from '../lib/svg-illustration';

async function main() {
  if (!process.argv.includes('--live')) {
    console.log(
      'Use --live to generate and validate source-grounded SVG illustrations with the installed Codex harness.'
    );
    return;
  }
  const directory = path.resolve('docs/research/generated-illustrations');
  await fs.mkdir(directory, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-illustration-eval-'));
  await build({
    stdin: {
      contents: `import {app} from 'electron';import fs from 'node:fs';import {validateSvgIllustrationInBrowser} from './src/explainer-validation';app.whenReady().then(async()=>{try{const rendered=await validateSvgIllustrationInBrowser(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));fs.writeFileSync(process.argv[3],JSON.stringify(rendered));app.exit(0);}catch(error){console.error(String(error));app.exit(1);}});`,
      resolveDir: process.cwd(),
    },
    outfile: path.join(temp, 'validate.cjs'),
    bundle: true,
    platform: 'node',
    external: ['electron'],
  });
  let currentCase = 'example';
  let renderAttempt = 0;
  async function validate(illustration: SvgIllustration, signal?: AbortSignal) {
    const file = path.join(temp, 'scene.json');
    const attempt = ++renderAttempt;
    await fs.writeFile(
      path.join(directory, `${currentCase}-candidate-${attempt}.json`),
      JSON.stringify(illustration, null, 2)
    );
    await fs.writeFile(file, JSON.stringify(illustration));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        electron as unknown as string,
        [path.join(temp, 'validate.cjs'), file, path.join(temp, 'render.json')],
        { env, signal }
      );
      let error = '';
      child.stderr.on('data', (data) => {
        error += String(data);
      });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(error.slice(-5000) || 'Browser validation failed'))
      );
    });
    const render = JSON.parse(await fs.readFile(path.join(temp, 'render.json'), 'utf8')) as IllustrationRender;
    for (const [index, image] of render.images.entries())
      await fs.writeFile(
        path.join(directory, `${currentCase}-render-${attempt}-sheet-${index + 1}.png`),
        Buffer.from(image.base64, 'base64')
      );
    return render;
  }
  try {
    const results: {
      id: string;
      title: string;
      filePath: string;
      questions: string;
      code: string;
      slide: Awaited<ReturnType<typeof generateSlide>>;
      model: string;
      generatedAt: string;
    }[] = [];
    const cases = [
      ...MECHANISM_CASES,
      {
        id: 'rotation',
        title: 'Rotating an array',
        filePath: 'rotate.ts',
        questions:
          'How do three in-place reversals rotate [A,B,C,D,E] right by 2 while restoring order within each moved group? What happens to the same elements during the three phases?',
        code: `export function rotateRight(items, k) {
  if (!items.length) return items;
  k = ((k % items.length) + items.length) % items.length;
  function reverse(start, end) {
    while (start < end) {
      [items[start], items[end]] = [items[end], items[start]];
      start++; end--;
    }
  }
  // Replaces repeated pop/unshift with three in-place reversals.
  reverse(0, items.length - 1);
  reverse(0, k - 1);
  reverse(k, items.length - 1);
  return items;
}`,
      },
    ];
    const selected = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7);
    for (const item of cases.filter((item) => !selected || item.id === selected)) {
      currentCase = item.id;
      renderAttempt = 0;
      console.log(`Planning ${item.id} with ${DEFAULT_CODEX_MODEL}…`);
      const numbered = item.code
        .split('\n')
        .map((line, i) => `${i + 1}: ${line}`)
        .join('\n');
      const context = `Synthetic evaluation: ${item.title}. Source ${item.filePath}:\n${numbered}\nQuestions: ${item.questions}\nInputs are illustrative, not production measurements. Do not inspect the environment or use tools.`;
      if (process.argv.includes('--review-only')) {
        const result = JSON.parse(
          await fs.readFile(path.join(directory, `${item.id}.json`), 'utf8')
        ) as (typeof results)[number];
        const scene = result.slide.svgIllustration;
        if (!scene) throw new Error(`No saved illustration for ${item.id}`);
        result.slide.svgIllustration = await reviewIllustration({
          illustration: scene,
          render: await validate(scene),
          source: context,
          model: DEFAULT_CODEX_MODEL,
          generate: (options) => getProvider('codex').generate(options),
          renderIllustration: validate,
          onReview: (critique, repaired) => console.log(item.id, { critique, repaired }),
        });
        results.push(result);
        await fs.writeFile(path.join(directory, `${item.id}.json`), JSON.stringify(result, null, 2));
        continue;
      }
      const plan = await planReview(
        `[hunk-0] ${context}`,
        'Keep this change in one topic using hunk-0. First decide which visual form explains its difficult relationship best; justify that choice in visualApproach.',
        'codex',
        DEFAULT_CODEX_MODEL,
        undefined,
        false,
        AbortSignal.timeout(240000)
      );
      await fs.writeFile(path.join(directory, `${item.id}-plan.json`), JSON.stringify(plan, null, 2));
      console.log(`Drawing ${item.id}: ${JSON.stringify(plan.topics[0]?.diagramBrief)}`);
      const slide = await generateSlide({
        providerName: 'codex',
        model: DEFAULT_CODEX_MODEL,
        topicContext: `${context}\n<diagram_brief>${JSON.stringify(plan.topics[0]?.diagramBrief)}</diagram_brief>\nEvaluate the purpose-designed SVG format for this change. Choose the visual form yourself before authoring svgIllustration. No fixed shape or scenario count is required.`,
        validateIllustration: validate,
        signal: AbortSignal.timeout(600000),
      });
      const result = { ...item, slide, model: DEFAULT_CODEX_MODEL, generatedAt: new Date().toISOString() };
      results.push(result);
      await fs.writeFile(path.join(directory, `${item.id}.json`), JSON.stringify(result, null, 2));
      console.log(
        slide.svgIllustration
          ? `${item.id}: validated ${slide.svgIllustration.scenarios.length} scenarios`
          : `${item.id}: no valid illustration; inspect saved output`
      );
    }
    const previous = JSON.parse(await fs.readFile('tests/fixtures/illustration-generated.json', 'utf8')) as {
      id: string;
    }[];
    const output = selected
      ? [
          ...previous.map((item) => results.find((result) => result.id === item.id) ?? item),
          ...results.filter((result) => !previous.some((item) => item.id === result.id)),
        ]
      : results;
    await fs.writeFile('tests/fixtures/illustration-generated.json', JSON.stringify(output, null, 2) + '\n');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
