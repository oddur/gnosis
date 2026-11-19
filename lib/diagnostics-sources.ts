/**
 * Parts of the renderer's diagnostics export that live in modules the export does not import, such as the hunk-scope
 * read queue (lib/use-syntax-contents.ts). Main bundles lib/diagnostics.ts, so this module imports nothing.
 */
const sources = new Map<string, () => unknown>();
export function addDiagnosticsSource(name: string, read: () => unknown) {
  sources.set(name, read);
}
export const diagnosticsSources = (): [string, () => unknown][] => [...sources];
