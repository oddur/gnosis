/** Executable syntax recipes used in prompts and checked against the bundled compiler. */
export const D2_RECIPES = [
  {
    name: 'Decision: one concrete state explains the constraint without a call trace',
    source: `direction: right
edit: "Illustrative edit\\nExpected version: 7"
write: "One atomic UPDATE\\nMatch id and expected version\\nStored version: 8\\nMismatch: no write"
result: "0 affected rows: conflict\\nReload before deciding what to submit"
edit -> write: body + expected version
write -> result: affected row count
`,
  },
  {
    name: 'Architecture: show ownership and the important data path',
    source: `direction: right
client: Caller { icon: gnosis:user }
service: Service boundary {
  direction: down
  handler: Handler { icon: gnosis:server }
  jobs: Durable jobs { shape: cylinder; icon: gnosis:database }
  handler -> jobs: persist before acknowledging
}
worker: Worker {
  icon: gnosis:code
  tooltip: "Retries can repeat a delivery. Check where duplicate effects are prevented."
}
client -> service.handler: submit job
service.jobs -> worker: claim
`,
  },
  {
    name: 'Sequence: pin the invariant, then spotlight the exchange',
    source: `shape: sequence_diagram
caller: Caller { icon: gnosis:user }
api: Handler { icon: gnosis:server }
store: Store { icon: gnosis:database }
caller -> api.run: update(expected_version)
api.guard: "Keep expected version" {
  tooltip: "Replacing the caller's version with a fresh read would silently permit a stale write."
}
api.run -> store: compare-and-set
store -> api.run: applied or conflict
api.run -> caller: result

`,
  },
  {
    name: 'Algorithm: show the state at a decision boundary',
    source: `direction: right
pending: "Pending: A, B, C" { width: 280 }
slots: "In flight: 0 / 2" { width: 280 }
dispatch: "Dispatch: none" { width: 280 }
pending -> slots: acquire slot
slots -> dispatch: dispatch
steps: {
  reserve_a: {
    pending.label: "Pending: B, C"
    slots.label: "In flight: 1 / 2"
    dispatch.label: "Dispatch: A"
    (slots -> dispatch)[0].style.stroke-width: 4
  }
  capacity_reached: {
    pending.label: "Pending: C"
    slots.label: "In flight: 2 / 2"
    dispatch.label: "Dispatch: A, B"
    slots.tooltip: "C must wait until a completion or cancellation releases a slot."
    slots.style.stroke-width: 4
  }
}
`,
  },
  {
    name: 'Before and after: make a changed dependency visible',
    source: `direction: right
ui: UI { icon: gnosis:code }
api: Remote API { icon: gnosis:cloud }
ui -> api: blocking read
steps: {
  local_snapshot: {
    (ui -> api)[0]: null
    cache: Snapshot { shape: cylinder; icon: gnosis:database }
    ui -> cache: immediate read
    cache -> api: refresh
    cache.tooltip: "Show snapshot freshness; a fast local read does not imply current remote state."
  }
}
`,
  },
] as const;
