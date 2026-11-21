import { planReview } from '../lib/agent';
import { DEFAULT_CLAUDE_MODEL, type ModelId, type Provider } from '../lib/models';
import {
  LEVELS,
  estimate,
  fixtureHash,
  formatReplay,
  loadFixtures,
  noiseEngine,
  plannerInput,
  prepareFixture,
  promptHash,
  replay,
  ruleCutsFor,
  commitRecording,
} from './explanation-noise-eval-lib';

/**
 * npm run explanation-noise-eval              Replay: rules, then recorded planner answers. Free; CI runs it as a test.
 * npm run explanation-noise-eval -- --live    Prints the estimated cost of calling the real planner for every fixture
 *                                             at Conservative and Aggressive. Add --yes to run it and record the
 *                                             answers and a manifest under tests/fixtures/explanation-noise/recorded.
 * Options for --live: --provider claude|codex, --model <id>, --effort <level>, --only <fixture id>.
 */
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function live() {
  const provider = (option('--provider') ?? 'claude') as Provider;
  const model = (option('--model') ?? DEFAULT_CLAUDE_MODEL) as ModelId;
  const effort = option('--effort') as import('../lib/effort').Effort | undefined;
  const only = option('--only');
  const fixtures = loadFixtures().filter((fixture) => !only || fixture.id === only);
  const engine = noiseEngine();
  const cost = await estimate(fixtures, model, (prepared, level) => ruleCutsFor(engine, prepared, level));
  console.log(
    `Live planner run: ${cost.calls} calls (${fixtures.length} fixtures x ${LEVELS.length} levels) with ${provider} ${model}.\n` +
      `Estimated ${cost.inputTokens.toLocaleString()} input and ${cost.outputTokens.toLocaleString()} output tokens` +
      (cost.usd !== undefined ? `, about $${cost.usd.toFixed(2)} at API prices.` : '. No price table for this model.')
  );
  if (!args.includes('--yes')) {
    console.log('Nothing was called. Add --yes to run it.');
    return;
  }
  // Each level's recording and manifest entry are written together; --only leaves other fixtures' entries alone.
  for (const fixture of fixtures) {
    const prepared = prepareFixture(fixture);
    const record = {
      recordedAt: new Date().toISOString(),
      provider,
      model,
      ...(effort ? { effort } : {}),
      fixtureHash: fixtureHash(fixture),
    };
    for (const level of LEVELS) {
      const input = plannerInput(prepared, await ruleCutsFor(engine, prepared, level), level);
      console.log(`[live] ${fixture.id} at ${level}`);
      const plan = await planReview(input.hunkIndex, input.context, provider, model, undefined, false, undefined, { effort }, level);
      commitRecording(level, fixture.id, plan, record, { promptHash: promptHash(level), evidenceHash: input.evidenceHash, options: input.options });
    }
  }
  console.log(`Recorded ${fixtures.length * LEVELS.length} planner answers. Replay scores them:`);
}

async function main() {
  if (args.includes('--live')) {
    await live();
    if (!args.includes('--yes')) return;
  }
  const fixtures = loadFixtures();
  const result = await replay(fixtures);
  console.log(formatReplay(result, fixtures.length));
  if (result.failed) process.exitCode = 1;
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
