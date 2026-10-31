/** Keep action entry points independent from the lazily loaded code editor. */
export function openConflictWorkspace(url: string) {
  window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts', { detail: url }));
}
