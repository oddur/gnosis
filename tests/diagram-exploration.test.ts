import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagramFocus, normalizeDiagramExploration, type DiagramExploration } from '../lib/diagram-exploration';
import { normalizeSvgIllustration } from '../lib/svg-illustration';
import { EXPLORATION_FIXTURE } from './fixtures/diagram-exploration';

void test('exploration preserves identities and evidence without prescribing geometry', () => {
  assert.deepEqual(normalizeSvgIllustration(EXPLORATION_FIXTURE), EXPLORATION_FIXTURE);
  assert.ok(EXPLORATION_FIXTURE.exploration);
  const diagram = structuredClone(EXPLORATION_FIXTURE.exploration);
  assert.deepEqual(diagramFocus(diagram, 'review'), ['review', 'review-read', 'cache']);
  assert.deepEqual(diagramFocus(diagram, 'preload-read'), ['preload-read', 'preload', 'cache']);
  assert.deepEqual(diagramFocus(diagram, 'missing'), []);
  assert.deepEqual(diagramFocus(diagram, null), []);
});
void test('untrusted exploration rejects broken endpoints, duplicate IDs, invalid evidence and oversized metadata', () => {
  const source = EXPLORATION_FIXTURE.exploration;
  assert.ok(source);
  for (const mutate of [
    (d: DiagramExploration) => {
      d.relationships[0].to = 'missing';
    },
    (d: DiagramExploration) => {
      d.relationships[0].id = d.entities[0].id;
    },
    (d: DiagramExploration) => {
      d.entities[0].id = '<script>';
    },
    (d: DiagramExploration) => {
      d.entities[0].evidence = { filePath: 'fixture.ts', startLine: -1 };
    },
    (d: DiagramExploration) => {
      d.entities[0].summary = 'x'.repeat(501);
    },
  ]) {
    const copy: DiagramExploration = structuredClone(source);
    mutate(copy);
    assert.equal(normalizeDiagramExploration(copy), null);
    assert.equal(normalizeSvgIllustration({ ...EXPLORATION_FIXTURE, exploration: copy }), null);
  }
});
