import { useEffect, useMemo, useReducer, useRef } from 'react';
import { pathEnabled, type CodeIntelligenceSettings } from './code-intelligence';
import type { GapHunk } from './diff-gaps';
import { pathFileKinds } from './file-kinds';
import { inspectionFileRequest, inspectionFiles, onInspectionForget, onInspectionUses } from './inspection-cache';
import { addDiagnosticsSource } from './diagnostics-sources';
import { forgetCarry } from './symbol-carry';
import { onMoves, peekFileMoves } from './moved-symbols-store';
import type { PrChangeFile, PrChanges, PrFileSide } from './pr-changes';
import { imageMimeType } from './review-images';
import { hidden, noiseFilterOn, noiseLabel, patchHunks, type NoiseFilter, type NoiseKind } from './semantic-noise';
import { changedSymbolLines, changedSymbols, trivialSymbols } from './symbol-outline';
import { changedRowTexts, itemPrints } from './review-prints';
import { countedIds } from './tree-symbol-review';
import { syntaxContentsPlan, wholeFileText } from './syntax-contents';
import { SYNTAX_MAX_CHARACTERS, syntaxLanguage, type SyntaxDefinition, type SyntaxLanguage } from './syntax-scope';
import { onDefinitions, onNoise, peekDefinitions, peekFileNoise, readDefinitions } from './syntax-scope-client';
import type { FileSymbols } from './tree-symbol-paths';
import { symbolTree, topLevelChanges, treeSymbolLanguage } from './tree-symbols';
import { syntaxContents, syntaxContentsJob, whenSettled } from './use-syntax-contents';

/** A file of the Changes tree as the diff reads it: `fileKey` is its revision key (`changeFileKey`). */
export interface TreeSymbolSource {
  fileKey: string;
  snapshot: PrChanges;
  file: PrChangeFile;
}

const NO_DEFINITIONS: readonly SyntaxDefinition[] = [];
const LFS = 'version https://git-lfs.github.com/spec/';
const TOO_LARGE = 'Too large to list symbols';

/** The path a file's symbols are named by: a deleted file's old one. */
const symbolPath = (file: PrChangeFile) => (file.status === 'deleted' ? (file.previousPath ?? file.path) : file.path);

/**
 * Whether a file lists symbols in the tree, and so has a chevron: a language whose tags name definitions, on in
 * Settings › Code intelligence, and not an image or a generated file, which the diff gives no structure either.
 */
export function treeSymbolsSupported({ snapshot, file }: Pick<TreeSymbolSource, 'snapshot' | 'file'>, settings: CodeIntelligenceSettings) {
  const path = symbolPath(file);
  if (!treeSymbolLanguage(syntaxLanguage(path)) || !pathEnabled(settings, path) || imageMimeType(path)) return false;
  return !(snapshot.fileKinds?.[file.path] ?? pathFileKinds(file.path)).generated.value;
}

/** What a file still waits for: its contents, or the parse of a side the view has. */
type Need =
  | { kind: 'read'; plan: { both: boolean; characters: number } }
  | { kind: 'parse'; sides: { key: string; language: SyntaxLanguage; text: string }[] };

const textOf = (side: PrFileSide | undefined) => (side?.kind === 'text' ? side.content : undefined);
const sideReason = (side: PrFileSide) => (side.kind === 'lfs' ? 'Stored in Git LFS' : side.kind === 'image' ? 'An image has no symbols' : 'No text to read symbols from');

interface Peeked {
  value: FileSymbols;
  need?: Need;
  /** The file's read or parse failed: it is not asked for again, only watched. */
  failed?: boolean;
}
/** Files whose patch and symbols are kept, newest last. */
const MADE_FILES = 2_000;
/** Each file's patch as hunks, and what its scopes read: both walk the whole patch, and the tree looks often. */
const patches = new Map<
  string,
  { url: string; patch?: string; settings: CodeIntelligenceSettings; hunks: ReturnType<typeof patchHunks>; plan: ReturnType<typeof syntaxContentsPlan> }
>();
function patchOf({ fileKey, snapshot, file }: TreeSymbolSource, settings: CodeIntelligenceSettings) {
  const known = patches.get(fileKey);
  if (known && known.patch === file.patch && known.settings === settings) return known;
  const value = {
    url: snapshot.url,
    patch: file.patch,
    settings,
    hunks: patchHunks(file.patch),
    plan: syntaxContentsPlan(snapshot, file, (path) => pathEnabled(settings, path)),
  };
  patches.delete(fileKey);
  patches.set(fileKey, value);
  for (const key of patches.keys()) {
    if (patches.size <= MADE_FILES) break;
    patches.delete(key);
  }
  return value;
}
/** The last result per file, with what it was made from: the tree renders often, and most files did not change. */
const made = new Map<string, { url: string; inputs: readonly unknown[]; peeked: Peeked }>();
// Both leave with their PR's inspection data (a closed tab, an idle PR, a cache reset), as the definitions they were
// made from do: every file of a PR is looked up, and each entry holds its patch, its hunks and its definitions.
onInspectionForget((urls) => {
  for (const cache of [patches, made] as Map<string, { url: string }>[])
    for (const [key, entry] of cache) if (!urls || urls.has(entry.url)) cache.delete(key);
  // Carry-over's per-PR state too: its registered patches, the revisions done, the items Changed.
  forgetCarry(urls);
});
onInspectionUses((into) => {
  // A PR whose files only these still hold is swept when idle, as its definitions are.
  for (const entry of patches.values()) if (!into.has(entry.url)) into.set(entry.url, -Infinity);
});
addDiagnosticsSource('treeSymbols', () => ({
  patches: { entries: patches.size, bytes: [...patches.values()].reduce((sum, entry) => sum + 2 * (entry.patch?.length ?? 0), 0) },
  made: made.size,
}));

/**
 * A file's symbols from what the caches already hold, the way the diff finds them (components/useDiffFileModel.tsx):
 * the same text, parsed under the same keys, so a file the view or the prefetch parsed shows at once, and the tree and
 * the outline have the same symbols. Reads nothing: `need` says what is missing.
 */
function peekFileSymbols(
  source: TreeSymbolSource,
  settings: CodeIntelligenceSettings,
  filter: NoiseFilter,
  failure: string | undefined
): Peeked {
  const peeked = lookUp(source, settings, filter);
  // A read or parse that failed says why while the file still waits for it. The caches come first: once the file is in
  // them after all (Retry in its diff), its symbols show. Its need stays, so the tree keeps watching for that read.
  return failure && peeked.value.state === 'loading' ? { value: { state: 'none', reason: failure }, need: peeked.need, failed: true } : peeked;
}
function lookUp(source: TreeSymbolSource, settings: CodeIntelligenceSettings, filter: NoiseFilter): Peeked {
  const { fileKey, snapshot, file } = source;
  const { hunks, plan: planned } = patchOf(source, settings);
  // GitHub sends no patch for a very large diff.
  if (!hunks) return { value: { state: 'none', reason: file.additions + file.deletions ? TOO_LARGE : 'No changed lines' } };
  const request = inspectionFileRequest(snapshot, file);
  const wholeSide = file.status === 'added' ? 'after' : file.status === 'deleted' ? 'before' : undefined;
  const read = (): Peeked => {
    const wanted = planned;
    return wanted ? { value: { state: 'loading' }, need: { kind: 'read', plan: wanted } } : { value: { state: 'none', reason: TOO_LARGE } };
  };
  let afterText: string | undefined, beforeText: string | undefined;
  if (wholeSide) {
    const both = inspectionFiles.peek(request);
    const side = wholeSide === 'after' ? (both?.after ?? inspectionFiles.peekAfter(request)) : both?.before;
    const whole = (file.patch && wholeFileText(file.patch, wholeSide)) ?? textOf(side);
    if (whole === undefined) return side ? { value: { state: 'none', reason: sideReason(side) } } : read();
    if (whole.startsWith(LFS)) return { value: { state: 'none', reason: 'Stored in Git LFS' } };
    if (wholeSide === 'after') afterText = whole;
    else beforeText = whole;
  } else {
    const both = inspectionFiles.peek(request);
    const after = both?.after ?? inspectionFiles.peekAfter(request);
    if (!after || (planned?.both && !both)) return read();
    if (after.kind !== 'text') return { value: { state: 'none', reason: sideReason(after) } };
    afterText = after.content;
    // The old side names removed symbols; it is parsed when the patch deletes lines, as the view parses it.
    const deletes = hunks.some((hunk) => hunk.rows.some((row) => row.type === '-'));
    if (deletes && pathEnabled(settings, file.previousPath ?? file.path)) beforeText = textOf(both?.before);
  }
  if ((afterText?.length ?? 0) > SYNTAX_MAX_CHARACTERS || (beforeText?.length ?? 0) > SYNTAX_MAX_CHARACTERS)
    return { value: { state: 'none', reason: TOO_LARGE } };
  const sides: { key: string; language: SyntaxLanguage; text: string }[] = [];
  const definitions = (side: 'after' | 'before', text: string | undefined) => {
    if (text === undefined) return undefined;
    const language = syntaxLanguage(side === 'after' ? file.path : (file.previousPath ?? file.path));
    const key = `${fileKey}:${side}`;
    const known = peekDefinitions(key);
    if (!known && language) sides.push({ key, language, text });
    return known;
  };
  const after = definitions('after', afterText);
  const before = definitions('before', beforeText);
  if (sides.length) return { value: { state: 'loading' }, need: { kind: 'parse', sides } };
  // An added file has no old side, so every symbol in it is added; a deleted file has no new side.
  const fileDefinitions =
    wholeSide === 'after' ? { after, before: NO_DEFINITIONS } : wholeSide === 'before' ? { after: NO_DEFINITIONS, before } : { after, before };
  const blocks = noiseFilterOn(filter) ? peekFileNoise(fileKey) : undefined;
  const moves = peekFileMoves(fileKey);
  const inputs = [fileDefinitions.after, fileDefinitions.before, blocks, moves, file.patch, filter];
  const last = made.get(fileKey);
  if (last && last.inputs.length === inputs.length && last.inputs.every((value, index) => value === inputs[index])) return last.peeked;
  const gapHunks: GapHunk[] = hunks.map((hunk) => ({ ...hunk, noEofOld: false, noEofNew: false }));
  // Lines the reader hides as noise (#396): a symbol whose every change is one reads as quiet.
  let quiet: Set<string> | undefined;
  const hiddenBlocks = (blocks ?? []).filter((block) => hidden(block.kind, filter));
  for (const block of hiddenBlocks) {
    quiet ??= new Set();
    for (let i = 0; i < block.oldCount; i++) quiet.add(`b${block.oldStart + i}`);
    for (let i = 0; i < block.newCount; i++) quiet.add(`a${block.newStart + i}`);
  }
  const all = changedSymbols(gapHunks, fileDefinitions) ?? [];
  const quietLines = quiet;
  const shown = quietLines ? (changedSymbols(gapHunks, fileDefinitions, (side, line) => quietLines.has(`${side[0]}${line}`)) ?? []) : all;
  const nodes = symbolTree(all, shown, moves?.marks, (symbol) => {
    // What the quiet blocks inside the symbol are, on its side: "Formatting only", "Comments only".
    const { start, end } = symbol.definition;
    const kinds: NoiseKind[] = [];
    for (const block of hiddenBlocks) {
      const [from, count] = symbol.side === 'after' ? [block.newStart, block.newCount] : [block.oldStart, block.oldCount];
      if (from <= end && from + Math.max(count, 1) - 1 >= start) kinds.push(block.kind);
    }
    return noiseLabel(kinds);
  }, trivialSymbols(gapHunks, fileDefinitions, undefined, quietLines && ((side, line) => quietLines.has(`${side[0]}${line}`))));
  const top = treeTop(gapHunks, fileDefinitions, quietLines);
  // What each counted item reads, from the text at hand, for its tick to carry to the next revision.
  const prints = itemPrints({
    items: countedIds({ state: 'ready', nodes, top }) ?? [],
    nodes,
    top,
    after: afterText,
    before: beforeText,
    rows: changedRowTexts(gapHunks),
    own: changedSymbolLines(gapHunks, fileDefinitions),
  });
  const peeked: Peeked = { value: { state: 'ready', nodes, top, prints } };
  made.delete(fileKey);
  made.set(fileKey, { url: snapshot.url, inputs, peeked });
  for (const key of made.keys()) {
    if (made.size <= MADE_FILES) break;
    made.delete(key);
  }
  return peeked;
}

/** A file's symbols from what the caches hold now, reading nothing: `loading` while they are not known. */
export const peekTreeSymbols = (source: TreeSymbolSource, settings: CodeIntelligenceSettings, filter: NoiseFilter): FileSymbols =>
  peekFileSymbols(source, settings, filter, undefined).value;

/**
 * Reads and parses one file at the top priority, as a file on screen is, until its symbols are known or `waitMs` has
 * passed: `n` reads the next file only when the walk gets to it. A read still running when the wait ends goes on, so
 * asking again soon finds it done; the result is then still `loading`.
 */
export async function loadTreeSymbols(
  source: TreeSymbolSource,
  settings: CodeIntelligenceSettings,
  filter: NoiseFilter,
  waitMs: number
): Promise<FileSymbols> {
  const deadline = Date.now() + waitMs;
  const { fileKey, snapshot, file } = source;
  // A read, then the parse of each side: a few rounds at most.
  for (let round = 0; round < 4; round++) {
    const peeked = peekFileSymbols(source, settings, filter, undefined);
    const need = peeked.need;
    const left = deadline - Date.now();
    if (!need || left <= 0) return peeked.value;
    const work =
      need.kind === 'read'
        ? new Promise<void>((resolve, reject) => {
            syntaxContents.request(syntaxContentsJob({ key: fileKey, snapshot, file }, need.plan), resolve, (failure) =>
              reject(Error(failure.message.replace(/\.$/, '') || 'Couldn’t read this file'))
            );
          })
        : Promise.all(
            need.sides.map((side) =>
              readDefinitions({ key: side.key, url: snapshot.url, language: side.language, text: side.text, priority: 'view' }).catch(() => {
                throw Error('Couldn’t parse this file');
              })
            )
          ).then(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      work.then(
        () => ({ kind: 'done' as const }),
        (error: unknown) => ({ kind: 'failed' as const, reason: error instanceof Error ? error.message : 'Couldn’t read this file' })
      ),
      new Promise<{ kind: 'late' }>((resolve) => (timer = setTimeout(() => resolve({ kind: 'late' }), left))),
    ]);
    clearTimeout(timer);
    if (outcome.kind === 'failed') return { state: 'none', reason: outcome.reason };
    if (outcome.kind === 'late') return { state: 'loading' };
  }
  return peekFileSymbols(source, settings, filter, undefined).value;
}

/** A file's top-level changes, marked quiet when every one of them is a quiet line, as a quiet symbol is. */
function treeTop(
  hunks: readonly GapHunk[],
  definitions: { after?: readonly SyntaxDefinition[]; before?: readonly SyntaxDefinition[] },
  quiet: ReadonlySet<string> | undefined
) {
  const top = topLevelChanges(hunks, definitions);
  if (!top || !quiet) return top;
  return topLevelChanges(hunks, definitions, (side, line) => quiet.has(`${side[0]}${line}`)) ? top : { ...top, quiet: true };
}

/**
 * The symbols of the tree's files, by entry key. Every file in `files` is looked up in the caches, which reads
 * nothing; the files in `load` (the ones the reader expanded) are read and parsed at the top priority, as a file on
 * screen is (`view`), and show "Loading symbols…" meanwhile. Results that land while the reader scrolls render once
 * the view is still.
 */
export function useTreeSymbols(
  files: ReadonlyMap<string, TreeSymbolSource>,
  load: ReadonlySet<string>,
  settings: CodeIntelligenceSettings,
  filter: NoiseFilter
): ReadonlyMap<string, FileSymbols> {
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const pending = useRef<() => void>(undefined);
  const later = useRef(() => {});
  later.current = () => {
    if (pending.current) return;
    pending.current = whenSettled(() => {
      pending.current = undefined;
      bump();
    });
  };
  useEffect(() => {
    const changed = () => later.current();
    // A file's symbols can show (and count) once its parse lands, whoever asked for it: a view, the prefetch, `n`.
    const stops = [onNoise(changed), onMoves(changed), onDefinitions(changed)];
    return () => {
      stops.forEach((stop) => stop());
      pending.current?.();
      pending.current = undefined;
    };
  }, []);
  // Why a file has no symbols, once its read or parse failed for good.
  const failures = useRef(new Map<string, string>());
  const peeked = useMemo(() => {
    const out = new Map<string, Peeked>();
    for (const [key, source] of files) out.set(key, peekFileSymbols(source, settings, filter, failures.current.get(source.fileKey)));
    return out;
  }, [files, settings, filter, version]);
  // Reads and parses asked for, by file revision key and side: each is asked once while its file is expanded.
  const asked = useRef(new Map<string, () => void>());
  useEffect(() => {
    const wanted = new Set<string>();
    for (const key of load) {
      const source = files.get(key);
      const found = peeked.get(key);
      const need = found?.need;
      if (!source || !need) continue;
      const { fileKey, snapshot } = source;
      if (need.kind === 'read') {
        const id = `${fileKey}:read`;
        wanted.add(id);
        if (asked.current.has(id)) continue;
        // A read that lands, whoever asked for it, ends a failure.
        const stopWatching = syntaxContents.watch(fileKey, () => {
          failures.current.delete(fileKey);
          later.current();
        });
        if (found.failed) {
          asked.current.set(id, stopWatching);
          continue;
        }
        const cancel = syntaxContents.request(
          syntaxContentsJob({ key: fileKey, snapshot, file: source.file }, need.plan),
          () => later.current(),
          (failure) => {
            failures.current.set(fileKey, failure.message.replace(/\.$/, '') || 'Couldn’t read this file');
            bump();
          }
        );
        asked.current.set(id, () => {
          stopWatching();
          cancel();
        });
      } else
        for (const side of need.sides) {
          wanted.add(side.key);
          if (asked.current.has(side.key) || found.failed) continue;
          asked.current.set(side.key, () => {});
          void readDefinitions({ key: side.key, url: snapshot.url, language: side.language, text: side.text, priority: 'view' }).then(
            () => later.current(),
            () => {
              failures.current.set(fileKey, 'Couldn’t parse this file');
              bump();
            }
          );
        }
    }
    // A file collapsed before its read ran withdraws it.
    for (const [id, cancel] of asked.current)
      if (!wanted.has(id)) {
        cancel();
        asked.current.delete(id);
      }
  }, [load, files, peeked]);
  useEffect(
    () => () => {
      for (const cancel of asked.current.values()) cancel();
      asked.current.clear();
    },
    []
  );
  return useMemo(() => new Map([...peeked].map(([key, value]) => [key, value.value])), [peeked]);
}
