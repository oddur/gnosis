import type { D2DiagramSpec } from '../../lib/types';

/** Illustrative examples, not claims about a particular PR or Gnosis internals. */
export const D2_EXAMPLES: { id: string; title: string; summary: string; diagram: D2DiagramSpec }[] = [
  {
    id: 'architecture',
    title: 'A fast review, without a request storm',
    summary: 'Architecture · boundaries, role icons, annotated paths',
    diagram: {
      kind: 'map',
      steps: [
        {
          board: 'overview',
          title: 'Overview',
          description: 'A local snapshot serves the UI while a scheduler controls refresh work.',
        },
        {
          board: 'overview',
          title: 'Read the local snapshot',
          change: 'Opening a PR reads the revision cache.',
          description: 'A cached read keeps navigation responsive while fresh data is fetched.',
          focus: ['desktop.(ui -> cache)[0]'],
        },
        {
          board: 'overview',
          title: 'Schedule the network request',
          change: 'The queue sends a conditional request.',
          description: 'Visible work takes priority over prefetch; shared scheduling bounds concurrent requests.',
          focus: ['(sync.queue -> github)[0]'],
        },
        {
          board: 'overview',
          title: 'Check the revision before publishing',
          change: 'The gate publishes only a matching response.',
          description: 'A response for an older head must not replace the snapshot of the newer revision.',
          focus: ['(sync.gate -> desktop.cache)[0]'],
        },
      ],
      caption:
        'The UI reads a local snapshot. A scheduler owns network traffic, and a revision check prevents an old response from replacing newer data.',
      source: `direction: right
reviewer: Reviewer { icon: gnosis:user }
desktop: Desktop {
  direction: down
  ui: Review workspace { icon: gnosis:code }
  cache: Revision cache {
    shape: cylinder
    icon: gnosis:database
    tooltip: "A snapshot belongs to a specific head SHA. It can be displayed immediately while a refresh runs."
  }
  ui -> cache: read locally
}
sync: Background sync {
  direction: down
  queue: Priority queue {
    icon: gnosis:queue
    tooltip: "Visible work takes priority; background prefetch yields when API capacity is scarce."
  }
  gate: Revision gate {
    icon: gnosis:shield
    tooltip: "Discard a late response if its head SHA no longer matches the requested revision."
  }
  queue -> gate: completed response
}
github: GitHub API { icon: gnosis:cloud }
reviewer -> desktop.ui: inspect PR
desktop.ui -> sync.queue: request refresh
sync.queue -> github: conditional request { style.animated: true }
github -> sync.gate: body or 304
sync.gate -> desktop.cache: publish snapshot { style.animated: true }
`,
    },
  },
  {
    id: 'sequence',
    title: 'An approval must match the code you saw',
    summary: 'Sequence · ordered messages, invariant notes, guided playback',
    diagram: {
      kind: 'walkthrough',
      caption:
        'Illustrative review submission protocol. The displayed revision remains the authority, even when discovery has found a newer commit.',
      steps: [
        {
          board: 'overview',
          focus: [],
          title: 'Overview',
          description:
            'Read down the sequence. The approval carries the displayed head SHA; the server rejects it if that revision has moved.',
        },
        {
          board: 'overview',
          focus: ['(reviewer -> app)[0]', 'app.pin'],
          change: 'Capture the SHA of the code currently on screen.',
          title: 'Pin the displayed revision',
          description: 'The click captures the displayed snapshot, not the newest head found by background discovery.',
        },
        {
          board: 'overview',
          focus: ['(app -> api)[0]'],
          change: 'Send the approval with the pinned SHA.',
          title: 'Submit the exact revision',
          description:
            'The request carries the pinned SHA. A background refresh must not replace it with a newer commit.',
        },
        {
          board: 'overview',
          focus: ['(api -> app)[0]'],
          change: 'Accept the matching revision, or reject the stale approval.',
          title: 'Check at the write boundary',
          description:
            'The server validates the revision when writing. A mismatch returns the reviewer to the changed code before approval.',
        },
      ],
      source: `shape: sequence_diagram
reviewer: Reviewer { icon: gnosis:user }
app: Review app { icon: gnosis:code }
api: Server { icon: gnosis:cloud }
reviewer -> app: Approve displayed revision
app.pin: "Pin displayed SHA" {
  tooltip: "Never substitute a newer discovery SHA for the snapshot currently on screen."
}
app -> api: Submit approval + pinned SHA { style.animated: true }
api -> app: Accepted or stale {
  tooltip: "Check the expected revision at the write boundary; a separate read can race with a push."
}

`,
    },
  },
  {
    id: 'change',
    title: 'Move slow work off the request path',
    summary: 'Change walkthrough · inherited boards, active paths, failure boundary',
    diagram: {
      kind: 'comparison',
      caption: 'Illustrative architecture change: acknowledge durable work quickly, then process it asynchronously.',
      steps: [
        {
          title: 'Before · the request waits for work',
          description:
            'A slow processor consumes the entire request deadline. A timeout leaves the caller uncertain about the outcome.',
        },
        {
          title: 'After · acknowledge only durable work',
          description:
            'Persist the job before acknowledging it. Returning success earlier would lose work if the process crashes.',
        },
        {
          title: 'Failure path · retry without duplicating effects',
          description:
            'Delivery can repeat. The worker needs an idempotency key so a retry does not apply the same change twice.',
        },
      ],
      source: `direction: right
client: Client { icon: gnosis:user }
api: Request handler { icon: gnosis:server }
worker: Processor { icon: gnosis:code }
client -> api: request
api -> worker: do work { style.animated: true }
worker -> api: result
steps: {
  durable_queue: {
    (api -> worker)[0]: null
    (worker -> api)[0]: null
    queue: Durable jobs {
      shape: cylinder
      icon: gnosis:database
      tooltip: "Acknowledge after persistence. Otherwise a process crash can silently lose an accepted job."
    }
    api -> queue: persist job
    queue -> worker: claim job { style.animated: true }
    api -> client: accepted
  }
  safe_retry: {
    worker.tooltip: "Use the job ID as an idempotency key; at-least-once delivery is not exactly-once execution."
    worker -> queue: retry on failure { style.stroke-dash: 5; style.animated: true }
  }
}
`,
    },
  },
  {
    id: 'algorithm',
    title: 'Capacity controls dispatch',
    summary: 'Illustrative example · two slots, three waiting jobs',
    diagram: {
      kind: 'walkthrough',
      caption: 'A job must acquire a slot before it can run.',
      source: `direction: right
pending: "Waiting: A, B, C" { width: 260 }
slots: "In flight: 0 / 2" { width: 260 }
pending -> slots: acquire slot
steps: {
  first: { pending.label: "Waiting: B, C"; slots.label: "In flight: 1 / 2" }
  full: { pending.label: "Waiting: C"; slots.label: "In flight: 2 / 2" }
}`,
      steps: [
        {
          board: 'overview',
          title: 'Two slots limit dispatch',
          description: 'This example starts with A, B, and C waiting.',
          focus: [],
        },
        {
          board: 'steps.first',
          title: 'A takes the first slot',
          description: 'One slot remains available for the next job.',
          focus: ['(pending -> slots)[0]'],
        },
        {
          board: 'steps.full',
          title: 'Capacity is full: C must wait',
          description: 'A completion must release a slot before C can run.',
          focus: ['slots'],
        },
      ],
    },
  },
];
