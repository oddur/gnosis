/** Curated example, not a live PR. Coordinates keep command identity stable across steps. */
export const examplePrs = [
  {
    number: 120,
    title: 'Add a concurrency limit',
    role: 'Foundation',
    file: 'queue.ts',
    heading: 'One slot means one active command',
    description: 'acquire() waits until the slot is free. Holding that slot must cover the entire worker operation.',
    code: [
      'const queue = new Semaphore(1);',
      '',
      'const slot = await queue.acquire();',
      '// Hold the slot while work runs.',
      'slot.release();',
    ],
  },
  {
    number: 121,
    title: 'Hold the slot until the worker finishes',
    role: 'Builds on #120',
    file: 'dispatch.ts',
    heading: 'Why return await matters here',
    description:
      'Both versions return a promise. Only return await keeps finally from releasing the slot before the worker finishes.',
    code: [
      'async function dispatch(command) {',
      '  const slot = await queue.acquire();',
      '  try {',
      '    return worker.run(command);',
      '    return await worker.run(command);',
      '  } finally {',
      '    slot.release();',
      '  }',
      '}',
    ],
  },
  {
    number: 122,
    title: 'Test that a second command waits',
    role: 'Builds on #121',
    file: 'dispatch.test.ts',
    heading: 'Test the overlap, not just the result',
    description:
      'Let A stay pending, then submit B. B must not start until A settles. Also test rejection: finally must still release the slot.',
    code: [
      'const a = dispatch(commandA);',
      'const b = dispatch(commandB);',
      'await worker.waitForStart("A");',
      'await flushMicrotasks();',
      'expect(worker.started).toEqual(["A"]);',
      '',
      'worker.finish("A");',
      'await worker.waitForStart("B");',
      'expect(worker.started).toEqual(["A", "B"]);',
      'worker.finish("B");',
      'await Promise.all([a, b]);',
    ],
  },
];

export const awaitFrames = [
  {
    title: 'A starts; B is waiting',
    caption: 'A owns the only slot. Its worker operation is still pending.',
    before: { positions: [270, 70], active: 1, peak: 1, slot: 'Held by A', line: 3 },
    after: { positions: [270, 70], active: 1, peak: 1, slot: 'Held by A', line: 4 },
  },
  {
    title: 'The cleanup runs too early',
    caption:
      'Before: return exits try, so finally releases the slot. A is still running. After: await keeps the slot held.',
    before: { positions: [270, 70], active: 1, peak: 1, slot: 'Free while A runs', line: 6 },
    after: { positions: [270, 70], active: 1, peak: 1, slot: 'Held by A', line: 4 },
  },
  {
    title: 'B starts while A is still running',
    caption:
      'Before: B takes the freed slot and starts; its cleanup also runs early. Two commands now run despite the limit of one.',
    before: { positions: [245, 305], active: 2, peak: 2, slot: 'Free while A and B run', line: 6 },
    after: { positions: [270, 70], active: 1, peak: 1, slot: 'Held by A; B waits', line: 4 },
  },
  {
    title: 'A finishes; the fixed version can start B',
    caption: 'After: A settles, finally releases its slot, and B starts. Before: B was already running.',
    before: { positions: [470, 270], active: 1, peak: 2, slot: 'Free while B runs', line: -1 },
    after: { positions: [470, 270], active: 1, peak: 1, slot: 'Held by B', line: 4 },
  },
  {
    title: 'Same results. Different concurrency.',
    caption:
      'Both commands finish in both versions. The fix keeps the peak at one active command. The original reached two.',
    before: { positions: [445, 505], active: 0, peak: 2, slot: 'Free', line: -1 },
    after: { positions: [445, 505], active: 0, peak: 1, slot: 'Free', line: 6 },
  },
];
