// Prototype checks proposed for #444's verifyProposals (lib/conflict-verify.ts). The lab runs them after #444's own
// checks, to measure what they would change; #444's code is not modified. Each returns a failing note or undefined.
import { parseConflicts } from '../lib/conflict-blocks.ts';

const NAME = /[A-Za-z_$][\w$]*/g;
const names = (text) => {
  const counts = new Map();
  for (const m of text.matchAll(NAME)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  return counts;
};

/**
 * Fix 1, a name one side removed comes back in a Merged block. One side renamed or deleted it (a function, a parameter,
 * a keyword argument), and the other side's new code still uses it, so the result refers to something that no longer
 * exists. Language-agnostic: identifiers as words. A name counts as removed when the side dropped it from the whole
 * file, or from the conflict block's lines (a parameter renamed inside one function, while other functions keep
 * theirs); it must be in the other side's lines of that block and in the proposal.
 */
/** Keywords of the grammars Gnosis checks: a side that drops an `if` has not renamed anything. */
const KEYWORDS = new Set(
  'if else for while do return break continue switch case default match try catch finally throw throws new delete typeof instanceof in of is as await async yield function fn def func class struct enum interface impl trait type let const var val mut pub public private protected internal static readonly final abstract override virtual sealed import from export use using package namespace mod self this super true false null nil None True False void int string bool where with lambda pass raise except elif not and or go defer select chan map range'.split(
    ' '
  )
);
export function danglingName(file) {
  const [base, ours, theirs] = [file.base, file.ours, file.theirs].map(names);
  for (const s of parseConflicts(file.original)) {
    if (s.kind !== 'conflict') continue;
    const proposal = file.proposals?.[s.index];
    if (!proposal) continue;
    const block = { base: names(s.block.base ?? ''), ours: names(s.block.ours), theirs: names(s.block.theirs) };
    for (const word of names(proposal.text).keys()) {
      if (word.length < 2 || KEYWORDS.has(word)) continue;
      const removed = (side, other) =>
        block[other].has(word) &&
        ((base.has(word) && !{ ours, theirs }[side].has(word)) || (block.base.has(word) && !block[side].has(word)));
      if (removed('ours', 'theirs') || removed('theirs', 'ours'))
        return `${word} was removed or renamed on ${removed('ours', 'theirs') ? 'the PR' : 'main'}, but the proposal still uses it.`;
    }
  }
}

const SKIP = /^(import|from|using|use|return|if|for|while|else|case|default|#|\/\/|\/\*|\*|-\s)/;
/**
 * The name each top-level line of a block declares or keys, with a method's parameter list so overloads differ: the
 * last word before the first `(`, `=`, `:` or `,`. Only lines at the first line's indentation count, so
 * the `steps:` of two different YAML jobs do not count as one key twice.
 */
const leading = (text) => {
  const counts = new Map();
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const indent = lines.length ? /^\s*/.exec(lines[0])[0].length : 0;
  for (const line of lines) {
    if (/^\s*/.exec(line)[0].length !== indent) continue;
    // A Go method's receiver is not its name.
    const body = line.trim().replace(/^func\s*\([^)]*\)\s*/, 'func ');
    if (SKIP.test(body)) continue;
    const at = body.search(/[(=:,{]/);
    if (at <= 0) continue;
    const name = /["']?([\w$.-]+)["']?\s*$/.exec(body.slice(0, at))?.[1];
    if (!name) continue;
    const key =
      body[at] === '(' ? `${name}(${(/^\(([^)]*)\)/.exec(body.slice(at))?.[1] ?? '').replace(/\s+/g, ' ')})` : name;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};
/**
 * Fix 2, a Merged block declares the same name twice where neither side's lines did: two enum members, object keys,
 * struct fields or match arms with one name. #444's duplicate check only sees what the tag queries call definitions,
 * and those leave out enum members, fields and keys.
 */
export function duplicateMember(file) {
  for (const s of parseConflicts(file.original)) {
    if (s.kind !== 'conflict') continue;
    const proposal = file.proposals?.[s.index];
    if (!proposal) continue;
    const [result, ours, theirs] = [proposal.text, s.block.ours, s.block.theirs].map(leading);
    for (const [name, n] of result)
      if (n > Math.max(ours.get(name) ?? 0, theirs.get(name) ?? 0, 1))
        return `${name} is declared twice in the result.`;
  }
}

export function proposedChecks(file) {
  return danglingName(file) ?? duplicateMember(file);
}
