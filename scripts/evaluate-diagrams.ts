import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { D2 } from '@d2lang/d2';
import { generateSlide, planReview } from '../lib/agent';
import { DEFAULT_CODEX_MODEL } from '../lib/models';
import { compileD2Source } from '../lib/d2-compile';
import { buildTopicContext } from '../lib/context-builder';
import { diagramFrameCaption } from '../lib/diagram-spec';

// Explicit opt-in: this calls the installed Codex provider, using synthetic code only.
const cases = [
  {
    name: 'architecture',
    questions: ['When can a late response replace the snapshot?', 'What remains visible while refresh runs?'],
    code: `class Snapshots {
  private heads = new Map<string, string>();
  private snapshots = new Map<string, Snapshot>();
  setHead(pr: string, head: string) { this.heads.set(pr, head); }
  read(pr: string) { return this.snapshots.get(pr); }
  async refresh(pr: string) {
    const requestedHead = this.heads.get(pr);
    const snapshot = await github.load(pr, requestedHead);
    if (this.heads.get(pr) !== requestedHead) return; // new: discard late response
    this.snapshots.set(pr, snapshot);
  }
}
// UI reads read(pr) immediately; refresh(pr) is background work. No disk persistence.`,
  },
  {
    name: 'sequence',
    questions: [
      'Why can a stale editor not overwrite a newer version?',
      'Are the check and write atomic?',
      'What happens when zero rows match?',
    ],
    code: `async function updateDocument(id, expectedVersion, body) {
  // Replaces unconditional update. The comparison and update are one DB statement.
  const result = await db.execute(
    'UPDATE documents SET body = ?, version = version + 1 WHERE id = ? AND version = ?',
    [body, id, expectedVersion]);
  if (result.rowsAffected === 0) return { status: 409 }; // caller must reload
  return { status: 200 };
}
// The client sends the version from the document it displayed. No automatic retry.`,
  },
  {
    name: 'algorithm',
    questions: [
      'What runs first for weights [8,5,3] at capacity 12?',
      'Why can 3 not skip ahead of 5?',
      'How does an overweight item avoid blocking the queue forever?',
    ],
    code: `function takeBatch(pending, maxWeight) {
  // Previously limited only by item count. Now preserves order and bounds total weight.
  const batch = []; let weight = 0;
  while (pending.length > 0) {
    const next = pending[0];
    if (batch.length > 0 && weight + next.weight > maxWeight) break;
    batch.push(pending.shift()); weight += next.weight;
  }
  return batch; // a single overweight item still runs, avoiding permanent blockage
}
// Example: weights [8,5,3], maxWeight=12. First batch [8], remaining [5,3].
// It must not skip 5 to pack 3. Also explain [15,2] with maxWeight=12.`,
  },
  {
    name: 'simple',
    questions: ['What user-visible wording changed?'],
    omitDiagram: true,
    code: `// The only change is the label on the existing close button. Behavior is unchanged.
// Before: <Button onClick={onClose}>Dismiss</Button>
// After:  <Button onClick={onClose}>Close</Button>`,
  },
];

async function main() {
  if (!process.argv.includes('--live')) {
    console.log(
      'Use npm run eval:diagrams -- --live to evaluate synthetic examples through the planner and writer with the installed Codex provider. Output stays in a temporary directory.'
    );
    return;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-diagram-evaluation-'));
  console.log(`Evaluation output: ${directory}`);
  const d2 = new D2();
  const results = [];
  try {
    const selected = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7);
    for (const item of cases.filter((item) => !selected || item.name === selected)) {
      const start = Date.now();
      try {
        const plan = await planReview(
          `[hunk-0] Synthetic change:\n${item.code}`,
          `Synthetic explanation evaluation: ${item.name}. Keep this small change in one topic using hunk-0. Do not use tools or inspect the environment.`,
          'codex',
          DEFAULT_CODEX_MODEL,
          undefined,
          false,
          AbortSignal.timeout(180000)
        );
        await fs.writeFile(path.join(directory, `${item.name}-plan.json`), JSON.stringify(plan, null, 2));
        const topic = plan.topics[0];
        const context = buildTopicContext(topic, new Map(), {}, {}, {}, item.name, '', plan.storyArc, plan.topics);
        const slide = await generateSlide({
          providerName: 'codex',
          model: DEFAULT_CODEX_MODEL,
          signal: AbortSignal.timeout(180000),
          topicContext: `${context}\n\nExplain this synthetic change. Choose prose, inline explanation and an optional diagram according to what makes it easiest to understand. Do not use tools or inspect the environment.\n<synthetic_source>\n${item.code}\n</synthetic_source>`,
        });
        await fs.writeFile(path.join(directory, `${item.name}.json`), JSON.stringify(slide, null, 2));
        if (item.omitDiagram && slide.d2Diagram) throw new Error('A wording-only change should not require a diagram');
        if (!slide.d2Diagram) {
          results.push({
            case: item.name,
            diagram: 'omitted',
            questions: item.questions,
            seconds: Math.round((Date.now() - start) / 1000),
          });
          console.log(results[results.length - 1]);
          continue;
        }
        const compiled = await compileD2Source(d2, slide.d2Diagram.source, false);
        const boards = [
          { id: 'overview', board: compiled.diagram },
          ...(compiled.diagram.steps ?? []).flatMap((board) => (board ? [{ id: `steps.${board.name}`, board }] : [])),
          ...(compiled.diagram.scenarios ?? []).flatMap((board) =>
            board ? [{ id: `scenarios.${board.name}`, board }] : []
          ),
        ];
        for (const step of slide.d2Diagram.steps ?? []) {
          const board = boards.find((item) => item.id === (step.board || 'overview'))?.board;
          if (!board) throw new Error(`Unknown board: ${step.board}`);
          const ids = new Set([...board.shapes, ...board.connections].map((item) => item.id));
          for (const id of step.focus ?? []) if (!ids.has(id)) throw new Error(`Unknown focus: ${id}`);
        }
        for (const [index, { id, board }] of boards.entries()) {
          if (boards.length > 1 && !diagramFrameCaption(slide.d2Diagram, id, index)?.description)
            throw new Error(`Missing caption for ${id}`);
          const svg = await d2.render(board, { ...compiled.renderOptions, noXMLTag: true, pad: 24 });
          await fs.writeFile(path.join(directory, `${item.name}-${index}.svg`), svg);
        }
        results.push({
          case: item.name,
          rendered: true,
          frames: boards.length,
          views: slide.d2Diagram.steps?.length || 1,
          questions: item.questions,
          quality: 'Requires human assessment of accuracy, abstraction, redundancy and effort saved.',
          seconds: Math.round((Date.now() - start) / 1000),
        });
      } catch (error) {
        results.push({ case: item.name, rendered: false, error: String(error) });
        process.exitCode = 1;
      }
      console.log(results[results.length - 1]);
    }
  } finally {
    await d2.dispose();
  }
  await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(results, null, 2));
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
