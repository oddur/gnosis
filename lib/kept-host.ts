/**
 * Keeps an imperative renderer attached to its host element while React's Activity hides the host.
 *
 * Activity detaches the refs of a subtree it hides and attaches them again when it shows it. Pierre's React
 * wrappers answer a detach by tearing down what they rendered into the host, and an attach by rendering it all
 * again, so coming back to the Changes tab rebuilt a 3,000-line diff and the 600-file tree (#352). A hidden host
 * stays in the page, so a detach whose host is still connected parks the renderer instead; the next attach of the
 * same host by the same owner finds it parked and renders nothing. A parked host that leaves the page was unmounted
 * while hidden, and React does not detach it again, so a sweep releases it.
 */
const parked = new Map<Element, { owner: unknown; release: () => void }>();
let sweeper: ReturnType<typeof setInterval> | undefined;
const SWEEP_MS = 5000;

function sweep() {
  for (const [element, held] of parked)
    if (!element.isConnected) {
      parked.delete(element);
      held.release();
    }
  if (!parked.size && sweeper !== undefined) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
}

/**
 * Call from a ref callback with its host. `attach` renders into the host unless `owner` left it parked there; the
 * returned cleanup parks it, and `release` tears it down once the host has left the page.
 */
export function keepHost(element: Element, owner: unknown, attach: () => void, release: () => void): () => void {
  const held = parked.get(element);
  parked.delete(element);
  if (held && held.owner !== owner) held.release();
  if (held?.owner !== owner) attach();
  return () => {
    parked.set(element, { owner, release });
    // An unmount removes the host in the same commit; a hidden Activity leaves it in place.
    setTimeout(sweep, 0);
    sweeper ??= setInterval(sweep, SWEEP_MS);
  };
}
