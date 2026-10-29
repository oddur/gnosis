import fs from 'node:fs/promises';
import path from 'node:path';
import { generateSlide, planReview } from '../lib/agent';
import { DEFAULT_CODEX_MODEL } from '../lib/models';
import { MECHANISM_CASES } from '../tests/fixtures/mechanism-examples';
import { normalizeMechanism } from '../lib/mechanism';

async function main() {
  if (!process.argv.includes('--live')) {
    console.log(
      'Use --live to generate explanations with the installed Codex harness. Synthetic sources only; results remain local.'
    );
    return;
  }
  const directory = path.resolve('docs/research/generated-mechanisms');
  await fs.mkdir(directory, { recursive: true });
  const results = [];
  for (const item of MECHANISM_CASES) {
    console.log(`Generating ${item.id} with ${DEFAULT_CODEX_MODEL}…`);
    const numbered = item.code
      .split('\n')
      .map((line, i) => `${i + 1}: ${line}`)
      .join('\n');
    const context = `Synthetic evaluation: ${item.title}. Source ${item.filePath}:\n${numbered}\nQuestions: ${item.questions}\nThese are illustrative examples, not production measurements. Do not inspect the environment or use tools.`;
    const plan = await planReview(
      `[hunk-0] ${context}`,
      'Keep this small change in one topic using hunk-0.',
      'codex',
      DEFAULT_CODEX_MODEL,
      undefined,
      false,
      AbortSignal.timeout(240000)
    );
    await fs.writeFile(path.join(directory, `${item.id}-plan.json`), JSON.stringify(plan, null, 2));
    let slide = await generateSlide({
      providerName: 'codex',
      model: DEFAULT_CODEX_MODEL,
      topicContext: `${context}\n<diagram_brief>${JSON.stringify(plan.topics[0]?.diagramBrief)}</diagram_brief>\nFor this evaluation, use the animated mechanism format with the two source-grounded input scenarios described above.`,
      signal: AbortSignal.timeout(240000),
    });
    if (!normalizeMechanism(slide.mechanism)) {
      console.log(`${item.id}: retrying missing/invalid scene once`);
      slide = await generateSlide({
        providerName: 'codex',
        model: DEFAULT_CODEX_MODEL,
        topicContext: `${context}\nUse a mechanism with 2 or 3 nodes, 2 scenarios, and complete states for every node in every event. Return all required fields in the mechanism schema.`,
        signal: AbortSignal.timeout(240000),
      });
    }
    if (!slide.mechanism) throw new Error(`${item.id} did not produce a valid mechanism`);
    const result = { ...item, slide, model: DEFAULT_CODEX_MODEL, generatedAt: new Date().toISOString() };
    results.push(result);
    await fs.writeFile(path.join(directory, `${item.id}.json`), JSON.stringify(result, null, 2));
    console.log(`Saved ${item.id}: ${slide.mechanism.scenarios.length} scenarios`);
  }
  await fs.writeFile('tests/fixtures/mechanism-generated.json', JSON.stringify(results, null, 2) + '\n');
  console.log('Generated examples are ready: npm run diagrams:mechanisms');
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
