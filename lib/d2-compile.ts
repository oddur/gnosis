import type { D2 } from '@d2lang/d2';
import { prepareD2Source } from './d2-source';

/** Repair only dollar signs that the parser identified as invalid substitutions.
 * This leaves raw blocks, single-quoted strings, escaped dollars and ${variables}
 * untouched, and also works for explanations saved before this recovery existed.
 */
function escapeReportedDollars(source: string, error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  let diagnostics: unknown;
  try {
    diagnostics = JSON.parse(error.message);
  } catch {
    return null;
  }
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return null;
  const offsets = new Set<number>();
  for (const value of diagnostics) {
    if (!value || typeof value !== 'object') return null;
    const diagnostic = value as Record<string, unknown>;
    if (
      typeof diagnostic.errmsg !== 'string' ||
      !diagnostic.errmsg.endsWith('substitutions must begin on {') ||
      typeof diagnostic.range !== 'string'
    )
      return null;
    const match = /^index,\d+:\d+:(\d+)-\d+:\d+:\d+$/.exec(diagnostic.range);
    if (!match) return null;
    // D2.js ranges use JavaScript UTF-16 offsets, including after non-ASCII
    // text and surrogate pairs. Verify the character before changing anything.
    const offset = Number(match[1]);
    if (source[offset] !== '$' || source[offset + 1] === '{') return null;
    offsets.add(offset);
  }
  const parts: string[] = [];
  let previous = 0;
  for (const offset of [...offsets].sort((a, b) => a - b)) {
    parts.push(source.slice(previous, offset), '\\');
    previous = offset;
  }
  parts.push(source.slice(previous));
  return parts.join('');
}

export async function compileD2Source(d2: Pick<D2, 'compile'>, source: string, dark: boolean) {
  const prepared = prepareD2Source(source, dark);
  try {
    return await d2.compile(prepared, { layout: 'tala' });
  } catch (error) {
    const repaired = escapeReportedDollars(prepared, error);
    if (repaired === null) throw error;
    // One local parser recovery, with no model call or saved-source mutation.
    return d2.compile(repaired, { layout: 'tala' });
  }
}
