/**
 * Browser shortcuts a packaged build turns off: reload (Cmd/Ctrl+R), view source (Cmd/Ctrl+U) and print (Cmd/Ctrl+P).
 * Cmd/Ctrl+Shift+U stays: it opens a PR's Update menu (#542). With Cmd held, macOS reports the key unshifted, so
 * Shift is checked by itself.
 */
export function blocksPackagedShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): boolean {
  if (!(event.ctrlKey || event.metaKey)) return false;
  if (event.key.toLowerCase() === 'u' && event.shiftKey) return false;
  return event.key === 'r' || event.key === 'u' || event.key === 'p';
}
