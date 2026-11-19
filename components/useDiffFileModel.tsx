import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  afterLines,
  diffGaps,
  gapSize,
  knownLines,
  matchesAfter,
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
import { useSyntaxDefinitions } from '../lib/use-syntax-definitions';
import { useSyntaxContents, type SyntaxFile } from '../lib/use-syntax-contents';
import { pathEnabled, type CodeIntelligenceSettings } from '../lib/code-intelligence';
import { syntaxContentsPlan } from '../lib/syntax-contents';
import { keepDiffLineInView } from '../lib/diff-layout';
import { inspectionFiles } from '../lib/inspection-cache';
import type { PrFileContents, PrFileRequest, PrFileSide } from '../lib/pr-changes';
import { LoadingIndicator } from './LoadingState';
import type { GapStatus } from './ChangesDiff';

const NO_REVEALS: GapReveals = {};
const NO_PINS: readonly (readonly [number, number])[] = [];

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
  function readAfter(retry = false) {
    if (!request || ready || (currentAfter && !currentAfter.error && !retry)) return;
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
  const [gapReveals, setGapReveals] = useState<{ key: string; value: GapReveals }>();
  const reveals = gapReveals?.key === revealKey ? gapReveals.value : NO_REVEALS;
  const parts = useMemo(
    (): GapPart[] | undefined =>
      hunks &&
      (gaps
        ? revealedParts(hunks, gaps, reveals, lines)
        : hunks.map((hunk, index) => ({ kind: 'hunk' as const, key: `h${index}`, hunk }))),
    [hunks, gaps, reveals, lines]
  );
  const shown = useMemo(() => (parts ? shownLines(parts) : undefined), [parts]);
  // Enclosing definitions (#393), from text this view already has: the after side gaps reveal from, and the before
  // side when both sides are loaded. A file without a grammar, or with a stale after side, shows as before.
  // The old side is parsed only for hunks that delete lines and add none.
  const onlyDeletes = useMemo(
    () =>
      !!baseHunks?.some((hunk) => hunk.rows.some((row) => row.type === '-') && !hunk.rows.some((row) => row.type === '+')),
    [baseHunks]
  );
  const structure = pathEnabled(codeSettings, path);
  const beforeText =
    onlyDeletes && contents?.before.kind === 'text' && pathEnabled(codeSettings, previousPath ?? path)
      ? contents.before.content
      : undefined;
  const scopePlan = useMemo(
    () => (scopeFile ? syntaxContentsPlan(scopeFile.snapshot, scopeFile.file, (p) => pathEnabled(codeSettings, p)) : undefined),
    [scopeFile, codeSettings]
  );
  // Most files of a large PR have only their patch here. Once the diff is near the view, its contents load in the
  // background for its scopes, ahead of the PR's prefetch (lib/use-syntax-contents.ts): the after side, as a gap
  // reveal reads it, and both sides for hunks that only delete. Contents already cached are not read again.
  const structureRead = useSyntaxContents(
    sectionRef,
    readStructure && scopePlan && expandable && active && !!gaps && (scopePlan.both ? !contents : !afterSide)
      ? scopeFile
      : undefined
  );
  const definitions = useSyntaxDefinitions({
    key: fileKey,
    url: request?.url ?? '',
    path,
    previousPath,
    after: afterText,
    before: beforeText,
    enabled: structure && expandable && active && !!gaps && afterMatches === true,
  });
  const scopes = useMemo(
    () => (parts && shown && definitions.after ? hunkScopes(parts, gaps, definitions, shown.after) : undefined),
    [parts, gaps, definitions.after, definitions.before, shown]
  );
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
  // A pinned hunk header names the definitions around the line the reader is at (ChangesDiff).
  const scopeAt = useMemo(
    () =>
      scopes ? (point: LinePoint): readonly SyntaxDefinition[] | undefined => chainAt(definitions, point) : undefined,
    [scopes, definitions.after, definitions.before]
  );
  const scopeNote: ReactNode = scopes ? undefined : structureRead.state === 'failed' ? (
    <span className="diff-gap-structure" data-structure="failed">
      <span className="diff-gap-message">Couldn’t load structure.</span>
      <button type="button" className="diff-context-button diff-gap-text" onClick={structureRead.retry}>
        Try again
      </button>
    </span>
  ) : structurePending && provisional ? (
    <span className="diff-gap-structure" data-structure="loading">
      <LoadingIndicator announce={false}>Loading structure…</LoadingIndicator>
    </span>
  ) : undefined;
  const showDefinition = (plan: DefinitionReveal) => {
    if (!gaps || !hunks) return;
    // A topic shows lines outside what it saved once both sides say they are unchanged.
    if (partial) readAfter();
    if (plan.kind === 'whole') {
      setGapReveals({ key: revealKey, value: revealSpan(reveals, gaps, plan.start, plan.end) });
      return;
    }
    const next = pinLines(hunks, gaps, reveals, plan.start, plan.end);
    if (next.pin) setPinned({ key: revealKey, value: [...pins, next.pin] });
    setGapReveals({ key: revealKey, value: next.reveals });
  };
  // Short definitions show whole once their scopes are known, keeping the line at the top of the view in place.
  const autoOpened = useRef<string>(undefined);
  useEffect(() => {
    if (!scopes || !gaps || autoOpened.current === revealKey) return;
    autoOpened.current = revealKey;
    let next = reveals;
    for (const scope of scopes.values())
      if (scope.opens && scope.reveal?.kind === 'whole') next = revealSpan(next, gaps, scope.reveal.start, scope.reveal.end);
    if (next === reveals) return;
    if (partial) readAfter();
    if (sectionRef.current) keepDiffLineInView(sectionRef.current);
    setGapReveals({ key: revealKey, value: next });
  }, [scopes]);
  const lineCount = useMemo(
    () =>
      Math.max(
        after?.length ?? 0,
        ...(baseHunks ?? []).map((hunk) => Math.max(hunk.oldStart, hunk.newStart) + hunk.rows.length)
      ),
    [after, baseHunks]
  );
  const gapStatus: GapStatus =
    after && afterMatches === false
      ? { kind: 'stale' }
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
    structure: !!shownScopes,
    scopeNote,
    scopeAt,
    showDefinition,
    gapStatus,
    revealLines,
    canReveal,
    readAfter,
    lineCount,
    afterSide,
  };
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
