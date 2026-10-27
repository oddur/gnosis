/** Native states deliberately vary label sizes and emphasis. */
export const STABLE_D2_SOURCE = `direction: right
queue: "Pending: A"
worker: Worker
queue -> worker: dispatch
steps: {
  next: {
    queue.label: "Pending: A, B, C\\nWaiting for capacity"
    worker.style.stroke-width: 4
    (queue -> worker)[0].label: "dispatch when capacity is available"
  }
  done: {
    queue.label: "Empty"
    worker.label: "Work complete\\nRelease the reserved slot\\nWake the next caller"
  }
}`;
