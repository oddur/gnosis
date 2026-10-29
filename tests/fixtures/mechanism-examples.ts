import type { MechanismScene } from '../../lib/mechanism';
export const QUEUE_SCENE: MechanismScene = {
  version: 1,
  title: 'Why does the next item wait?',
  takeaway: 'The queue keeps its order, even when a smaller item would fit.',
  assumptions:
    'Illustrative weights and capacity. The source takes items in order and allows one overweight item to run alone.',
  nodes: [
    { id: 'pending', label: 'Pending queue', kind: 'queue', column: 0, row: 0 },
    { id: 'batch', label: 'Current batch', kind: 'queue', column: 1, row: 0 },
  ],
  edges: [{ id: 'take', from: 'pending', to: 'batch', label: 'Take first' }],
  scenarios: [
    {
      id: 'capacity',
      title: 'Next item does not fit',
      input: 'Weights [8, 5, 3] · capacity 12 (illustrative)',
      events: [
        {
          title: 'Start with an empty batch',
          caption: 'Take items from the front of the queue.',
          states: [
            { id: 'pending', value: 'Waiting in order', items: ['8', '5', '3'] },
            { id: 'batch', value: 'Weight 0 / 12', items: [] },
          ],
          focus: ['pending'],
          evidence: { filePath: 'batch.ts', startLine: 3 },
        },
        {
          title: 'Take the first item',
          caption: 'The batch now weighs 8. The next item weighs 5.',
          states: [
            { id: 'pending', value: 'Next: 5', items: ['5', '3'] },
            { id: 'batch', value: 'Weight 8 / 12', items: ['8'], tone: 'active' },
          ],
          focus: ['batch', 'take'],
          transfer: { edge: 'take', label: '8' },
          evidence: { filePath: 'batch.ts', startLine: 7 },
        },
        {
          title: 'Stop before the limit',
          caption: '8 + 5 exceeds 12. The queue does not skip 5 to take 3.',
          states: [
            { id: 'pending', value: 'Keep 5 before 3', items: ['5', '3'], tone: 'warning' },
            { id: 'batch', value: 'Return [8]', items: ['8'], tone: 'success' },
          ],
          focus: ['pending', 'batch'],
          evidence: { filePath: 'batch.ts', startLine: 6 },
        },
      ],
    },
    {
      id: 'overweight',
      title: 'One item exceeds capacity',
      input: 'Weights [15, 2] · capacity 12 (illustrative)',
      events: [
        {
          title: 'The first item exceeds the limit',
          caption: 'An empty batch can take one item of any weight.',
          states: [
            { id: 'pending', value: 'First: 15', items: ['15', '2'] },
            { id: 'batch', value: 'Empty', items: [] },
          ],
          focus: ['pending'],
        },
        {
          title: 'Run the oversized item alone',
          caption: 'The exception prevents 15 from blocking the queue forever.',
          states: [
            { id: 'pending', value: 'Next batch', items: ['2'] },
            { id: 'batch', value: 'Return [15]', items: ['15'], tone: 'success' },
          ],
          focus: ['batch'],
          transfer: { edge: 'take', label: '15' },
          evidence: { filePath: 'batch.ts', startLine: 6 },
        },
      ],
    },
  ],
};
export const MECHANISM_CASES = [
  {
    id: 'queue',
    title: 'Ordered batching',
    filePath: 'batch.ts',
    code: `export function takeBatch(pending, maxWeight) {
  // New: preserve order and bound total weight, instead of only item count.
  const batch = []; let weight = 0;
  while (pending.length > 0) {
    const next = pending[0];
    if (batch.length > 0 && weight + next.weight > maxWeight) break;
    batch.push(pending.shift()); weight += next.weight;
  }
  return batch;
}`,
    questions:
      'Explain [8,5,3] at capacity 12 and [15,2] at capacity 12. Why does 3 not skip ahead of 5? Why does 15 not block forever?',
  },
  {
    id: 'version',
    title: 'Rejecting a stale write',
    filePath: 'document.ts',
    code: `export async function updateDocument(id, expectedVersion, body) {
  // New: replace unconditional overwrite with one atomic conditional update.
  const result = await db.execute(
    'UPDATE documents SET body = ?, version = version + 1 WHERE id = ? AND version = ?',
    [body, id, expectedVersion]);
  if (result.rowsAffected === 0) return { status: 409 };
  return { status: 200 };
}
// Client supplies the version it read. There is no automatic retry.`,
    questions:
      'Explain expected version 7 vs stored version 8, then the matching version 7 vs 7. Show the stored value stays unchanged on rejection. The comparison and write are one database statement, not two operations.',
  },
];
