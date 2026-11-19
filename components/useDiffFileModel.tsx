import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  afterLines,
  diffGaps,
  firstMismatch,
  gapSize,
  lineEndings,
  knownLines,
  matchesAfter,
  patchLineEndings,
  pinLines,
  revealGap,
  revealSpan,
  revealedParts,
  shownLines,
  withPins,
  type DiffGap,
  type GapDirection,
  type GapHunk,
  type GapPart,
  type GapReveals,
} from '../lib/diff-gaps';
import { chainAt, hunkScopes, provisionalScopes, type HunkScope, type LinePoint } from '../lib/hunk-scopes';
import type { DefinitionReveal, SyntaxDefinition } from '../lib/syntax-scope';
import type { SyntaxPriority } from '../lib/syntax-parse-queue';
import { useSyntaxDefinitions } from '../lib/use-syntax-definitions';
import { raiseDefinitions, raiseNoise } from '../lib/syntax-scope-client';
import { useSyntaxContents, useViewTier, type SyntaxFile } from '../lib/use-syntax-contents';
import { pathEnabled, type CodeIntelligenceSettings } from '../lib/code-intelligence';
import { syntaxContentsPlan, wholeFileText } from '../lib/syntax-contents';
import { showScopePlan, type ScopeRail, type ShownScope } from '../lib/show-scope';
import { changedSymbols } from '../lib/symbol-outline';
import { useSemanticNoise } from '../lib/use-semantic-noise';
import { blockKey, fileNoise, hidden, noiseFilterOn, type FileNoise, type NoiseFilter, type NoiseKind } from '../lib/semantic-noise';
import { keepDiffLineInView } from '../lib/diff-layout';
import { inspectionFiles } from '../lib/inspection-cache';
import { traceStructure } from '../lib/structure-trace';
import { pathFileKinds } from '../lib/file-kinds';
import type { PrFileContents, PrFileRequest, PrFileSide } from '../lib/pr-changes';
import { staleAttemptKey, staleStatus, type StaleTarget } from '../lib/stale-diff-refresh';
import { staleDiffRefresh, useStaleAttempt } from '../lib/use-stale-diff-refresh';
import { LoadingIndicator } from './LoadingState';
import type { GapStatus } from './ChangesDiff';

const NO_REVEALS: GapReveals = {};
const NO_PINS: readonly (readonly [number, number])[] = [];
const NO_KEYS: ReadonlySet<string> = new Set();
const NO_SHOWN: readonly ShownScope[] = [];
const NO_DEFINITIONS: readonly SyntaxDefinition[] = [];
const NO_SHOWN_NOISE: ReadonlySet<string> = new Set();
/** Quiet changes the reader opened, by file revision (and a topic's hunks): kept for the session, newest last. */
const openedNoise = new Map<string, ReadonlySet<string>>();
const OPENED_NOISE_FILES = 500;

/**
 * The diff's quiet changes (#396), for ChangesDiff: each change block's kind, what the reader hides, and the blocks
 * the reader opened. `file` is set once the file is compared.
 */
export interface DiffNoise {
  kinds: ReadonlyMap<string, NoiseKind>;
  filter: NoiseFilter;
  /** Blocks the reader opened, by `blockKey`: they show whatever their kind. */
  shown: ReadonlySet<string>;
  show: (keys: readonly string[]) => void;
  /** The whole diff as the filter sees it: whether every change is hidden, and how much is. */
  file?: FileNoise;
  /** Every change is hidden and the reader opened none: the file shows as one bar. */
  fileHidden: boolean;
}
/**
 * One file's diff as Changes and Explanation topics show it (#157 parity): hunks with the gaps between them, the
 * lines revealed into those gaps, the after side gaps reveal from, and the tree-sitter scopes, provisional crumbs and
 * structure loading note of every hunk header. Both surfaces render the result with ChangesDiff, so a change here, in
 * ChangesDiff or in lib/diff-gaps.ts reaches both.
 */
export function useDiffFileModel({
  fileKey,
  revealKey = fileKey,
  path,
  previousPath,
  patch,
  hunks: baseHunks,
  known,
  partial = false,
  request,
  contents,
  expandable,
  active,
  scopeFile,
  readStructure,
  codeSettings,
  sectionRef,
  status,
  noiseFilter,
}: {
  /** The file's revision key (changeFileKey): reveals, pins and parsed definitions are kept under it. */
  fileKey: string;
  /** What reveals and pins are kept under, when the hunks can change for one file (a topic's pinned lines). */
  revealKey?: string;
  path: string;
  previousPath?: string;
  /** The file's GitHub-style patch: its hunk headers name each hunk until the definitions arrive. */
  patch?: string;
  /** The hunks the view shows, before anything is revealed. */
  hunks: GapHunk[] | undefined;
  /** New lines the view has without a read (a topic's saved hunks), by line number less one. */
  known?: readonly (string | undefined)[];
  /** The hunks are some of the file's (an Explanation topic): gaps that hold other changes never reveal. */
  partial?: boolean;
  /** Where the after side is read from; undefined when it cannot be read (a local review). */
  request?: PrFileRequest;
  /** Both sides, when the view has loaded them already. */
  contents?: PrFileContents;
  /** The file has gaps to reveal: not added, deleted or stored in LFS. */
  expandable: boolean;
  /** The file is open: collapsed files read nothing. */
  active: boolean;
  /** The file as the scope read sees it (lib/syntax-contents.ts): its plan says whether the file has a structure. */
  scopeFile?: SyntaxFile;
  /** Read the file's contents for its scopes once it is near the view, if the view has not loaded them. */
  readStructure: boolean;
  codeSettings: CodeIntelligenceSettings;
  /** The file's element: its nearness starts the scope read, and opening definitions keeps its top line in place. */
  sectionRef: RefObject<HTMLElement | null>;
  /** Added and deleted files are one hunk of the whole file: its structure comes from the patch (#394). */
  status?: string;
  /** What the reader hides as noise (Diff appearance): formatting-only and comment-only changes (#396). */
  noiseFilter: NoiseFilter;
}) {
  const alive = useRef(true);
  const currentFile = useRef(fileKey);
  currentFile.current = fileKey;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // The after side, read on the first reveal (#299). A topic's file reads both sides: its gaps can hide changes the
  // topic left out, and only the old side shows which.
  const [afterRead, setAfterRead] = useState<{ key: string; side?: PrFileSide; before?: PrFileSide; error?: string }>();
  const currentAfter = afterRead?.key === fileKey ? afterRead : undefined;
  const both = partial && request ? inspectionFiles.peek(request) : undefined;
  const afterSide =
    contents?.after ?? both?.after ?? (request ? inspectionFiles.peekAfter(request) : undefined) ?? currentAfter?.side;
  const beforeSide = contents?.before ?? both?.before ?? currentAfter?.before;
  const ready = partial ? !!afterSide && !!beforeSide : !!afterSide;
  // A file whose contents do not match its patch refreshes by itself, once (lib/stale-diff-refresh.ts).
  const attemptKey = request ? staleAttemptKey({ request, fileKey }) : undefined;
  const attempt = useStaleAttempt(attemptKey);
  function readAfter(retry = false) {
    if (!request || ready || attempt === 'refreshing' || (currentAfter && !currentAfter.error && !retry)) return;
    const key = fileKey;
    setAfterRead({ key });
    const read: Promise<{ key: string; side?: PrFileSide; before?: PrFileSide }> = partial
      ? inspectionFiles.read(request).then((value) => ({ key, side: value.after, before: value.before }))
      : inspectionFiles.readAfter(request).then((side) => ({ key, side }));
    read.then(
      (value) => {
        if (alive.current && currentFile.current === key) setAfterRead(value);
      },
      (error: unknown) => {
        if (alive.current && currentFile.current === key)
          setAfterRead({ key, error: error instanceof Error ? error.message : String(error) });
      }
    );
  }
  // An added file's new side, or a deleted file's old side, is the whole patch: parsed from it, with no read. A patch
  // that is not the whole file (left out or cut for a large file, a topic's few lines) reads the side instead.
  const wholeSide = status === 'added' ? 'after' : status === 'deleted' ? 'before' : undefined;
  const patchWhole = useMemo(() => (wholeSide && patch ? wholeFileText(patch, wholeSide) : undefined), [wholeSide, patch]);
  const afterText = afterSide?.kind === 'text' ? afterSide.content : undefined;
  const after = useMemo(() => (afterText === undefined ? undefined : afterLines(afterText)), [afterText]);
  const beforeAll = beforeSide?.kind === 'text' ? beforeSide.content : undefined;
  const before = useMemo(() => (beforeAll === undefined ? undefined : afterLines(beforeAll)), [beforeAll]);
  const afterMatches = useMemo(
    () => (after && baseHunks ? matchesAfter(baseHunks, after) : undefined),
    [after, baseHunks]
  );
  // The lines gaps reveal from: the after side once it agrees with the hunks (and, for a topic, once the old side has
  // shown which gaps hold other changes), else what the view already has.
  const lines = afterMatches && after && (!partial || before) ? after : known;
  // A long definition's signature, shown above its hunk, is a hunk of unchanged lines inside a gap (#393).
  const [pinned, setPinned] = useState<{ key: string; value: readonly (readonly [number, number])[] }>();
  const pins = pinned?.key === revealKey ? pinned.value : NO_PINS;
  const hunks = useMemo(
    () => (baseHunks && after && afterMatches && pins.length ? withPins(baseHunks, pins, after) : baseHunks),
    [baseHunks, after, afterMatches, pins]
  );
  const gaps = useMemo(() => {
    const all = expandable && hunks ? diffGaps(hunks, afterMatches && after ? after.length : undefined, { partial }) : undefined;
    if (!all || !partial) return all;
    // A topic's gap is unchanged code only where it saved those lines, or where both sides agree on every line.
    return all.map((gap) => {
      const size = gapSize(gap);
      if (size === undefined || (!gap.opaque && known && knownLines(known, gap.newStart, size))) return gap;
      const verified = !!before && !!after && !!afterMatches;
      if (verified && !gap.opaque && unchanged(before, after, gap, size)) return gap;
      // The hunk below sits this far apart on the two sides; the hunk above, `gap.oldOffset`.
      const next = hunks?.at(gap.index);
      if (verified) return { ...gap, opaque: true, ...agreeing(before, after, gap, size, next && next.oldStart - next.newStart) };
      // Until both sides are read, a gap that holds other changes shows the lines the topic saved next to its hunks.
      if (!gap.opaque) return gap;
      let revealDown = 0,
        revealUp = 0;
      while (revealDown < size && known?.[gap.newStart + revealDown - 1] !== undefined) revealDown++;
      while (revealUp < size - revealDown && known?.[gap.newStart + size - revealUp - 2] !== undefined) revealUp++;
      return { ...gap, revealDown, revealUp };
    });
  }, [expandable, hunks, afterMatches, after, before, partial, known]);
  // Enclosing definitions (#393), from text this view already has: the after side gaps reveal from, and the before
  // side when it is loaded. A file without a grammar, or with a stale after side, shows as before.
  // The old side is parsed when the file deletes lines: hunks that only delete are named by it, and the outline finds
  // removed symbols in it (lib/symbol-outline.ts).
  const deletes = useMemo(() => !!baseHunks?.some((hunk) => hunk.rows.some((row) => row.type === '-')), [baseHunks]);
  const structure = pathEnabled(codeSettings, path);
  const beforeWhole =
    beforeSide?.kind === 'text' ? beforeSide.content : wholeSide === 'before' ? patchWhole : undefined;
  const beforeText = deletes && pathEnabled(codeSettings, previousPath ?? path) ? beforeWhole : undefined;
  // What is parsed: the after side the view has, or an added file's patch.
  const afterParsed = afterText ?? (wholeSide === 'after' ? patchWhole : undefined);
  const wholeText = wholeSide === 'after' ? afterParsed : wholeSide === 'before' ? beforeText : undefined;
  // A Git LFS pointer is not the file, and generated files (lockfiles, bundles) have no structure worth parsing.
  const generated = !!wholeSide && (scopeFile?.snapshot.fileKinds?.[path] ?? pathFileKinds(path)).generated.value;
  const whole = !!wholeSide && !generated && !wholeText?.startsWith('version https://git-lfs.github.com/spec/');
  const scopePlan = useMemo(
    () => (scopeFile ? syntaxContentsPlan(scopeFile.snapshot, scopeFile.file, (p) => pathEnabled(codeSettings, p)) : undefined),
    [scopeFile, codeSettings]
  );
  // Most files of a large PR have only their patch here. Once the diff is near the view, its contents load in the
  // background for its scopes, ahead of the PR's prefetch (lib/use-syntax-contents.ts): the after side, as a gap
  // reveal reads it, and both sides for hunks that only delete. Contents already cached are not read again.
  const structureRead = useSyntaxContents(
    sectionRef,
    readStructure &&
      scopePlan &&
      active &&
      (wholeSide ? wholeText === undefined : expandable && !!gaps && (scopePlan.both ? !contents : !afterSide))
      ? scopeFile
      : undefined
  );
  const parseable = structure && active && (whole ? !!baseHunks : expandable && !!gaps);
  // Files on screen parse first, then files near the view, then the rest (lib/syntax-parse-queue.ts).
  const tier = useRef<SyntaxPriority>('near');
  const definitions = useSyntaxDefinitions({
    key: fileKey,
    url: request?.url ?? '',
    path,
    previousPath,
    after: afterParsed,
    before: beforeText,
    enabled: parseable && (whole || afterMatches === true),
    priority: tier,
  });
  // Formatting-only and comment-only changes (#396): compared in the worker once the after side agrees with the hunks,
  // while the reader hides either. Added and deleted files have no other side to compare.
  const noiseOn = noiseFilterOn(noiseFilter);
  const noise = useSemanticNoise({
    fileKey,
    url: request?.url ?? '',
    path,
    after: afterText,
    hunks: baseHunks,
    enabled: noiseOn && structure && active && !wholeSide && afterMatches === true,
    priority: tier,
    whole: !partial,
  });
  // Where the file is matters only while a side of it, or its comparison, waits: then it is watched, and a move
  // raises it.
  useViewTier(sectionRef, parseable && (!!definitions.parsing || !!definitions.beforeParsing || noise.pending), tier, (place) => {
    raiseDefinitions(`${fileKey}:after`, place);
    raiseDefinitions(`${fileKey}:before`, place);
    if (noise.key) raiseNoise(noise.key, place);
  });
  // What the reader opened stays open for the session, though the file's diff unmounts as it scrolls away.
  const [shownNoise, setShownNoise] = useState<{ key: string; value: ReadonlySet<string> }>();
  const noiseShown = shownNoise?.key === revealKey ? shownNoise.value : (openedNoise.get(revealKey) ?? NO_SHOWN_NOISE);
  // Changed lines the reader hides and has not opened: the outline leaves them out.
  const quietLines = useMemo(() => {
    if (!noiseOn || !noise.blocks) return undefined;
    const lines = new Set<string>();
    for (const block of noise.blocks) {
      if (!hidden(block.kind, noiseFilter) || noiseShown.has(blockKey(block))) continue;
      for (let i = 0; i < block.oldCount; i++) lines.add(`b${block.oldStart + i}`);
      for (let i = 0; i < block.newCount; i++) lines.add(`a${block.newStart + i}`);
    }
    return lines.size ? lines : undefined;
  }, [noiseOn, noise.blocks, noiseFilter.whitespace, noiseFilter.formatting, noiseFilter.comments, noiseShown]);
  const diffNoise = useMemo((): DiffNoise | undefined => {
    if (!noiseOn) return undefined;
    const file = noise.blocks ? fileNoise(noise.blocks, noiseFilter) : undefined;
    return {
      kinds: noise.kinds,
      filter: noiseFilter,
      shown: noiseShown,
      show: (keys) => {
        if (sectionRef.current) keepDiffLineInView(sectionRef.current);
        const value = new Set([...noiseShown, ...keys]);
        openedNoise.delete(revealKey);
        openedNoise.set(revealKey, value);
        for (const key of openedNoise.keys()) {
          if (openedNoise.size <= OPENED_NOISE_FILES) break;
          openedNoise.delete(key);
        }
        setShownNoise({ key: revealKey, value });
      },
      file,
      fileHidden: !!file?.all && !noise.blocks?.some((block) => noiseShown.has(blockKey(block))),
    };
  }, [noiseOn, noise.kinds, noise.blocks, noiseFilter.whitespace, noiseFilter.formatting, noiseFilter.comments, noiseShown, revealKey]);
  // An added file has no old side, so every symbol in it is added; a deleted file has no new side, so every symbol in
  // it is removed.
  const fileDefinitions = useMemo(
    () =>
      whole && wholeSide === 'after'
        ? { after: definitions.after, before: definitions.after && NO_DEFINITIONS }
        : whole && wholeSide === 'before'
          ? { after: definitions.before && NO_DEFINITIONS, before: definitions.before }
          : { after: definitions.after, before: definitions.before },
    [whole, wholeSide, definitions.after, definitions.before]
  );
  const [gapReveals, setGapReveals] = useState<{ key: string; value: GapReveals }>();
  // What the reader revealed: chevrons, Show all, Show whole function, crumbs.
  const userReveals = gapReveals?.key === revealKey ? gapReveals.value : NO_REVEALS;
  // Show scope (lib/show-scope.ts): a short definition around a change shows whole. The plan is made once per file
  // revision from what the diff shows before any reveal, so revealing lines never changes it; it is kept apart from
  // the reader's reveals, so a hunk, or the setting, can collapse it back to plain context.
  const scopeOn = codeSettings.enabled && codeSettings.showScope;
  const planned = useMemo(
    () =>
      // The old side names hunks that only delete: the plan waits for it, which lands right after the after side.
      scopeOn && definitions.after && !definitions.beforeParsing && hunks && gaps && lines
        ? showScopePlan(revealedParts(hunks, gaps, NO_REVEALS, lines), gaps, definitions)
        : undefined,
    [scopeOn, definitions.after, definitions.before, definitions.beforeParsing, hunks, gaps, lines]
  );
  const [adopted, setAdopted] = useState<{ key: string; value: readonly ShownScope[] }>();
  const [collapsed, setCollapsed] = useState<{ key: string; value: ReadonlySet<string> }>();
  // Once the file is parsed, its short definitions show whole, keeping the line at the top of the view in place.
  useEffect(() => {
    if (!planned || adopted?.key === revealKey) return;
    if (planned.length) {
      // A topic shows lines outside what it saved once both sides say they are unchanged.
      if (partial) readAfter();
      if (sectionRef.current) keepDiffLineInView(sectionRef.current);
    }
    setAdopted({ key: revealKey, value: planned });
  }, [planned]);
  const collapsedKeys = collapsed?.key === revealKey ? collapsed.value : NO_KEYS;
  const shownScopesPlan = useMemo(
    () => (scopeOn && adopted?.key === revealKey ? adopted.value.filter((scope) => !collapsedKeys.has(scope.key)) : NO_SHOWN),
    [scopeOn, adopted, revealKey, collapsedKeys]
  );
  const reveals = useMemo(() => {
    let next = userReveals;
    if (gaps) for (const scope of shownScopesPlan) for (const [start, end] of scope.spans) next = revealSpan(next, gaps, start, end);
    return next;
  }, [userReveals, shownScopesPlan, gaps]);
  const parts = useMemo(
    (): GapPart[] | undefined =>
      hunks &&
      (gaps
        ? revealedParts(hunks, gaps, reveals, lines)
        : hunks.map((hunk, index) => ({ kind: 'hunk' as const, key: `h${index}`, hunk }))),
    [hunks, gaps, reveals, lines]
  );
  const shown = useMemo(() => (parts ? shownLines(parts) : undefined), [parts]);
  const scopes = useMemo(() => {
    if (!parts || !shown || !fileDefinitions.after) return undefined;
    // An added or deleted file is one hunk with no gaps: its header names the file, or a definition around it all.
    const all = hunkScopes(parts, gaps ?? (whole ? [] : undefined), fileDefinitions, shown.after);
    if (!shownScopesPlan.length) return all;
    // A hunk whose definition, or one around it, shows whole by the rule can collapse it back.
    for (const [key, scope] of all) {
      const auto = [...scope.chain]
        .reverse()
        .map((crumb) => shownScopesPlan.find((s) => s.definition.start === crumb.definition.start && s.definition.end === crumb.definition.end))
        .find((match) => match !== undefined);
      if (auto) all.set(key, { ...scope, shown: { key: auto.key, definition: auto.definition } });
    }
    return all;
  }, [parts, gaps, whole, fileDefinitions, shown, shownScopesPlan]);
  // Each definition shown whole by the rule has a rail beside its line numbers (ChangesDiff).
  const rails = useMemo(
    (): readonly ScopeRail[] =>
      shownScopesPlan.map(({ definition }) => ({ start: definition.start, end: definition.end, signatureEnd: definition.signatureEnd })),
    [shownScopesPlan]
  );
  const collapseScope = (key: string) => {
    if (sectionRef.current) keepDiffLineInView(sectionRef.current);
    setCollapsed({ key: revealKey, value: new Set([...collapsedKeys, key]) });
  };
  // Until the definitions arrive, each hunk's location is its patch header's text, as GitHub shows it, or the file.
  const structurePending =
    structureRead.state === 'loading' || (structureRead.state === 'idle' && !!definitions.parsing);
  const provisional = useMemo(
    () =>
      !scopes && parts && gaps && scopePlan && expandable && afterMatches !== false
        ? provisionalScopes(parts, patch)
        : undefined,
    [scopes, parts, gaps, scopePlan, expandable, afterMatches, patch]
  );
  const shownScopes: ReadonlyMap<string, HunkScope> | undefined = scopes ?? provisional;
  useEffect(() => {
    if (scopes) traceStructure(fileKey, { shown: performance.now() });
  }, [!!scopes, fileKey]);
  // The symbols the hunks change (#394), for the file's outline, once the file is parsed; a quiet bar until then. When
  // the old side is on its way, the outline waits for it, in the same bar, so its removed symbols are not first listed
  // as modified ones: it parses right behind the after side, after the breadcrumbs have shown.
  const symbols = useMemo(
    () =>
      fileDefinitions.after && !definitions.beforeParsing && baseHunks
        ? changedSymbols(baseHunks, fileDefinitions, quietLines && ((side, line) => quietLines.has(`${side[0]}${line}`)))
        : undefined,
    [baseHunks, fileDefinitions, definitions.beforeParsing, quietLines]
  );
  // Symbols whose every change is hidden, for the outline's quiet note.
  const quietSymbols = useMemo(() => {
    if (!symbols || !quietLines || !fileDefinitions.after || !baseHunks) return 0;
    return Math.max(0, (changedSymbols(baseHunks, fileDefinitions)?.length ?? 0) - symbols.length);
  }, [symbols, quietLines, fileDefinitions, baseHunks]);
  // An added or deleted file's bar waits from the first render, as its patch parses, so nothing moves when it lands.
  const outlinePending =
    !symbols &&
    ((!!provisional && structurePending) ||
      (!!scopes && !!definitions.beforeParsing) ||
      (whole && parseable && (wholeText === undefined ? structureRead.state === 'loading' : !!(definitions.parsing || definitions.beforeParsing))));
  // "Loading structure…" shows only once a file has waited a moment: one whose structure lands sooner never flickers.
  const loadingShown = useDelayedFlag(structurePending && !!provisional && !scopes, STRUCTURE_NOTE_DELAY_MS);
  // A pinned hunk header names the definitions around the line the reader is at (ChangesDiff).
  const scopeAt = useMemo(
    () =>
      scopes ? (point: LinePoint): readonly SyntaxDefinition[] | undefined => chainAt(fileDefinitions, point) : undefined,
    [scopes, fileDefinitions]
  );
  const scopeNote: ReactNode = scopes ? undefined : structureRead.state === 'failed' ? (
    <span className="diff-gap-structure" data-structure="failed">
      <span className="diff-gap-message">Couldn’t load structure.</span>
      <button type="button" className="diff-context-button diff-gap-text" onClick={structureRead.retry}>
        Try again
      </button>
    </span>
  ) : loadingShown ? (
    <span className="diff-gap-structure" data-structure="loading">
      <LoadingIndicator announce={false}>Loading structure…</LoadingIndicator>
    </span>
  ) : undefined;
  const showDefinition = (plan: DefinitionReveal) => {
    if (!gaps || !hunks) return;
    // A topic shows lines outside what it saved once both sides say they are unchanged.
    if (partial) readAfter();
    if (plan.kind === 'whole') {
      setGapReveals({ key: revealKey, value: revealSpan(userReveals, gaps, plan.start, plan.end) });
      return;
    }
    const next = pinLines(hunks, gaps, userReveals, plan.start, plan.end);
    if (next.pin) setPinned({ key: revealKey, value: [...pins, next.pin] });
    setGapReveals({ key: revealKey, value: next.reveals });
  };
  const lineCount = useMemo(
    () =>
      Math.max(
        after?.length ?? 0,
        ...(baseHunks ?? []).map((hunk) => Math.max(hunk.oldStart, hunk.newStart) + hunk.rows.length)
      ),
    [after, baseHunks]
  );
  const stale = !!after && afterMatches === false;
  const staleTarget = useMemo(
    (): StaleTarget | undefined =>
      request && stale ? { request, fileKey, both: partial || !!contents, pinned: partial } : undefined,
    [request, stale, fileKey, partial, !!contents]
  );
  useEffect(() => {
    if (staleTarget && !attempt) staleDiffRefresh.report(staleTarget);
  }, [staleTarget, attempt]);
  // Still stale once the refresh and the read after it are done: the contents and the patch disagree at this
  // revision. The diagnostics export keeps where, and how the two end their lines.
  const mismatched = staleStatus(stale, !!request, attempt) === 'mismatch';
  useEffect(() => {
    if (!mismatched || !request || !attemptKey || !after || !baseHunks || afterText === undefined) return;
    const patch = patchLineEndings(baseHunks),
      file = lineEndings(afterText);
    staleDiffRefresh.mismatch(attemptKey, {
      url: request.url,
      path: request.path,
      headSha: request.headSha,
      line: firstMismatch(baseHunks, after),
      patch,
      file,
      lineEndingsDiffer:
        (patch.endings !== 'none' && file.endings !== 'none' && patch.endings !== file.endings) ||
        patch.bom !== file.bom ||
        (!patch.finalNewline && file.finalNewline),
    });
  }, [mismatched, attemptKey]);
  const contentsStatus = staleStatus(stale, !!request, attempt);
  const gapStatus: GapStatus = contentsStatus
    ? { kind: contentsStatus }
    : currentAfter?.error
        ? { kind: 'error', message: `Could not load more lines. ${currentAfter.error}` }
        : afterSide && afterSide.kind !== 'text'
          ? { kind: 'error', message: 'More lines are not available for this file.' }
          : currentAfter && !currentAfter.error && !ready
            ? { kind: 'loading' }
            : { kind: 'idle' };
  // A gap the view has every line of reveals at once; others wait for the after side.
  const covered = (gap: DiffGap) => {
    const size = gapSize(gap);
    return !!lines && size !== undefined && knownLines(lines, gap.newStart, size);
  };
  // Without a revision to read (a local review), a topic's gap reveals the saved lines next to its hunks.
  const nextToHunk = (gap: DiffGap) => {
    const size = gapSize(gap);
    return (
      !!lines &&
      ((gap.index > 0 && lines[gap.newStart - 1] !== undefined) ||
        (size !== undefined && gap.index < (hunks?.length ?? 0) && lines[gap.newStart + size - 2] !== undefined))
    );
  };
  const canReveal = (gap: DiffGap) =>
    gap.opaque ? !!(gap.revealDown || gap.revealUp) : !!request || nextToHunk(gap);
  /** A gap bar's Retry, or after a refresh that did not help, the reader's own Refresh. */
  const retry = () => {
    if (mismatched && staleTarget) staleDiffRefresh.retry(staleTarget);
    else readAfter(true);
  };
  const revealLines = (gap: DiffGap, direction: GapDirection) => {
    if (!hunks || !canReveal(gap)) return;
    const key = revealKey,
      count = hunks.length;
    setGapReveals((previous) => ({
      key,
      value: revealGap(previous?.key === key ? previous.value : NO_REVEALS, gap, count, direction),
    }));
    if (!covered(gap)) readAfter();
  };
  return {
    parts,
    gaps,
    hunks,
    shown,
    scopes: shownScopes,
    // An added or deleted file's one hunk header shows from the first render, naming the file until its patch is
    // parsed, so nothing below it moves when its breadcrumb arrives.
    structure: !!shownScopes || (whole && parseable && wholeText !== undefined),
    scopeNote,
    scopeAt,
    showDefinition,
    rails,
    collapseScope,
    symbols,
    quietSymbols,
    outlinePending,
    noise: diffNoise,
    gapStatus,
    revealLines,
    canReveal,
    readAfter,
    retry,
    lineCount,
    afterSide,
  };
}

/** How long a file's structure may take before its hunk headers say "Loading structure…". */
const STRUCTURE_NOTE_DELAY_MS = 150;
/** True once `on` has held for `ms`; false again as soon as it does not. */
function useDelayedFlag(on: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!on) {
      setHeld(false);
      return;
    }
    const timer = setTimeout(() => setHeld(true), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return on && held;
}

/** How many lines of a gap that holds other changes agree on both sides, from its top and from its bottom. */
function agreeing(
  before: readonly string[],
  after: readonly string[],
  gap: DiffGap,
  size: number,
  belowOffset: number | undefined
): { revealDown: number; revealUp: number } {
  let revealDown = 0,
    revealUp = 0;
  while (revealDown < size && before[gap.newStart + revealDown + gap.oldOffset - 1] === after[gap.newStart + revealDown - 1])
    revealDown++;
  const last = gap.newStart + size - 1;
  if (belowOffset !== undefined)
    while (revealUp < size - revealDown && before[last - revealUp + belowOffset - 1] === after[last - revealUp - 1]) revealUp++;
  return { revealDown, revealUp };
}

/** Whether a gap's lines are the same on both sides, so revealing it from the after side shows no change. */
function unchanged(before: readonly string[], after: readonly string[], gap: DiffGap, size: number): boolean {
  const last = gap.newStart + size - 1;
  // Below the last hunk, the old file must end where the new one does, less the hunks' difference.
  if (gap.newEnd === after.length && before.length !== after.length + gap.oldOffset) return false;
  for (let line = gap.newStart; line <= last; line++) if (before[line + gap.oldOffset - 1] !== after[line - 1]) return false;
  return true;
}
