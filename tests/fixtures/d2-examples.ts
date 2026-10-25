import type { D2DiagramSpec } from '../../lib/types';

/** Illustrative examples, not claims about a particular PR or Gnosis internals. */
export const D2_EXAMPLES: { id: string; title: string; summary: string; diagram: D2DiagramSpec }[] = [
  {
    id: 'architecture',
    title: 'A fast review, without a request storm',
    summary: 'Architecture · boundaries, role icons, annotated paths',
    diagram: {
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
      caption:
        'Illustrative review submission protocol. The displayed revision remains the authority, even when discovery has found a newer commit.',
      steps: [
        {
          title: 'The whole exchange',
          description:
            'Read down the sequence. The approval carries the displayed head SHA; the server rejects it if that revision has moved.',
        },
        {
          title: '1. Pin what the reviewer saw',
          description: 'The click captures the displayed snapshot, not the newest head found by background discovery.',
        },
        {
          title: '2. Submit the exact revision',
          description:
            'The request carries the pinned SHA. A background refresh must not replace it with a newer commit.',
        },
        {
          title: '3. Stop on a stale revision',
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
scenarios: {
  pin_revision: {
    (reviewer -> app)[0].style.stroke-width: 4
    app.pin.style.stroke-width: 4
  }
  submit_pinned: {
    (app -> api)[0].style.stroke-width: 4
  }
  validate_revision: {
    (api -> app)[0].style.stroke-width: 4
  }
}
`,
    },
  },
  {
    id: 'change',
    title: 'Move slow work off the request path',
    summary: 'Change walkthrough · inherited boards, active paths, failure boundary',
    diagram: {
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
];
