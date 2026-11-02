/** Curated sample, not a live PR. Each frame records the same commands at new positions. */
export const examplePrs = [
  {
    number: 120,
    title: 'Introduce a bounded queue',
    role: 'Foundation',
    file: 'queue.ts',
    heading: 'Keep the queue bounded.',
    description: 'Hold up to three commands. New arrivals wait when the queue is full.',
    code: [
      'const queue = new Queue({ capacity: 3 });',
      'queue.tryPush(commandA); // accepted',
      'queue.tryPush(commandB); // accepted',
      'queue.tryPush(commandC); // accepted',
      '// Further commands wait for room.',
    ],
    frames: [
      {
        title: 'Three commands arrive',
        caption: 'A, B, and C are ready. The queue has room for three.',
        places: [
          [36, 78],
          [88, 78],
          [140, 78],
        ],
        line: 0,
        limit: 'Queue · capacity 3',
      },
      {
        title: 'A and B enter',
        caption: 'The first two commands occupy two of the three slots.',
        places: [
          [248, 78],
          [300, 78],
          [140, 78],
        ],
        line: 2,
        limit: 'Queue · capacity 3',
      },
      {
        title: 'The queue is full',
        caption: 'C takes the last slot. Any further command must wait.',
        places: [
          [220, 78],
          [272, 78],
          [324, 78],
        ],
        line: 4,
        limit: 'Queue · full',
      },
    ],
  },
  {
    number: 121,
    title: 'Route worker commands',
    role: 'Builds on #120',
    file: 'worker.ts',
    heading: 'Commands keep their order.',
    description: 'The worker takes A and B together. C stays at the front of the queue.',
    code: [
      'const batch = queue.take(2);',
      'await worker.dispatch(batch);',
      '// A and B run in order.',
      '// C waits for the next batch.',
    ],
    frames: [
      {
        title: 'Commands wait in order',
        caption: 'A arrived first, followed by B and then C.',
        places: [
          [220, 78],
          [272, 78],
          [324, 78],
        ],
        line: 0,
        limit: 'Queue · batch limit 2',
      },
      {
        title: 'Take the next two',
        caption: 'The worker receives A and B. C stays queued.',
        places: [
          [430, 78],
          [482, 78],
          [220, 78],
        ],
        line: 1,
        limit: 'Queue · C remains',
      },
      {
        title: 'Keep the same order',
        caption: 'Run A before B. The next batch will start with C.',
        places: [
          [430, 78],
          [482, 78],
          [220, 78],
        ],
        line: 3,
        limit: 'Queue · next is C',
      },
    ],
  },
  {
    number: 122,
    title: 'Adapt the batch size',
    role: 'Builds on #121',
    file: 'batch.ts',
    heading: 'Let a busy queue take a larger batch.',
    description: 'In this example, three waiting commands increase the batch limit from two to three.',
    code: [
      'const limit = queue.size >= 3 ? 3 : 2;',
      'const batch = queue.take(limit);',
      'await worker.dispatch(batch);',
    ],
    frames: [
      {
        title: 'A busy queue',
        caption: 'Three commands are waiting. The normal batch limit is two.',
        places: [
          [220, 78],
          [272, 78],
          [324, 78],
        ],
        line: 0,
        limit: 'Queue · 3 waiting',
      },
      {
        title: 'Raise the batch limit',
        caption: 'The rule selects three, so all waiting commands fit.',
        places: [
          [220, 78],
          [272, 78],
          [324, 78],
        ],
        line: 1,
        limit: 'Queue · batch limit 3',
      },
      {
        title: 'Dispatch all three',
        caption: 'A, B, and C reach the worker together, still in order.',
        places: [
          [406, 78],
          [458, 78],
          [510, 78],
        ],
        line: 2,
        limit: 'Queue · empty',
      },
    ],
  },
];
