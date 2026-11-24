import { createHash } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { formatHunkIndexForPrompt, type IndexedHunk } from './diff-parse';
import { wholeHunk, type HunkSlice, type HunkSlices, type LineRange } from './explanation-slices';
import { resolveDiffHunks } from './hunk-ownership';
import type { DiffHunk, TopicPlan } from './types';

/**
 * Focused sections (#565, #562): the planner and writers work on units, a whole hunk or one slice of a large hunk
 * (lib/explanation-slices.ts). A section shows only the units it owns; a unit no section lists is left out of the
 * explanation and listed per file (`FocusedSections.outside`), unless all such code together is small, when it goes to
 * "Other changes" as before. A deleted slice whose definition provably moved is explained with its new copy.
 *
 * Everything here is pure, so the rules are tested without a model or a worker. The setting is off by default; when it
 * is off, none of this runs and the pipeline is unchanged.
 */

/** Left-over units under this many changed lines in total go to "Other changes" instead of the left-out list. */
export const FOCUS_OTHER_CHANGES_LINES = 20;

/** One unit the planner can list: a whole hunk (its hunk ID) or one slice of a large hunk (its slice ID). */
export interface FocusUnit {
  id: string;
  hunkId: string;
  filePath: string;
  /** The hunk is one unit: it keeps its hunk ID and shows as today. */
  whole: boolean;
  /** The unit's lines; a whole hunk's one slice. */
  slice: HunkSlice;
}

export interface FocusIndex {
  /** Every unit, in hunk order. */
  units: Map<string, FocusUnit>;
  /** IDs the planner may use that name other units: a sliced hunk's ID (all its slices), a whole hunk's slice ID. */
  aliases: Map<string, string[]>;
  /** A deleted unit whose definition moved, to the unit of its new copy: covered by the move, never shown alone. */
  movedAway: Map<string, string>;
  /** A content hash of the slices and their moves, for the explanation's checkpoint keys. */
  hash: string;
}

/** Where a moved definition came from, on the slide entry of its new copy. */
export interface SliceMoveSource {
  filePath: string;
  /** The old definition's lines in the old file, from 1, inclusive. */
  startLine: number;
  endLine: number;
  body: 'identical' | 'edited';
}

/** Code no section shows (#562), for "Code outside the explanation" (#563). */
export interface OutsideCode {
  filePath: string;
  /** The unit: a hunk ID, or a slice ID. */
  id: string;
  label: string;
  /** The changed lines' ranges on each side, from 1. */
  oldLines: LineRange[];
  newLines: LineRange[];
  additions: number;
  deletions: number;
}

/** Saved with an explanation made while the repository's Focused sections setting was on (ReviewGuide.focusedSections). */
export interface FocusedSections {
  /** The repository the setting was read from (explanationRepository). */
  repository?: string;
  /** Code no section shows, sorted by file and line. Empty when it all went to "Other changes". */
  outside: OutsideCode[];
}

const sliceHunk = (hunk: IndexedHunk) => ({ id: hunk.id, header: hunk.expandedHunkHeader, content: hunk.expandedContent });

/**
 * The units of the planning hunks. A hunk the slicer kept whole, or didn't answer for, is one unit with its hunk ID.
 * A move links two units only when the deleted one adds nothing (fail closed: anything else stays ordinary).
 */
export function focusIndex(hunks: readonly IndexedHunk[], sliced: readonly HunkSlices[]): FocusIndex {
  const byHunk = new Map(sliced.map((entry) => [entry.hunkId, entry]));
  const units = new Map<string, FocusUnit>();
  const aliases = new Map<string, string[]>();
  const unitOf = new Map<string, string>();
  for (const hunk of hunks) {
    const found = byHunk.get(hunk.id);
    const entry = found?.slices.length ? found : wholeHunk(sliceHunk(hunk), hunk.filePath, 'timeout');
    const whole = entry.slices.length === 1;
    for (const slice of entry.slices) {
      const id = whole ? hunk.id : slice.id;
      units.set(id, { id, hunkId: hunk.id, filePath: hunk.filePath, whole, slice });
      unitOf.set(slice.id, id);
      if (slice.id !== id) aliases.set(slice.id, [id]);
    }
    if (!whole) aliases.set(hunk.id, entry.slices.map((slice) => slice.id));
  }
  const movedAway = new Map<string, string>();
  for (const unit of units.values()) {
    const to = unit.slice.movedTo && unitOf.get(unit.slice.movedTo);
    if (to && to !== unit.id && units.has(to) && unit.slice.additions === 0) movedAway.set(unit.id, to);
  }
  const hash = createHash('sha256')
    .update(
      JSON.stringify(
        [...units.values()].map((u) => [u.id, u.slice.lines, u.slice.movedTo ?? null, u.slice.movedFrom ?? null, u.slice.moveBody ?? null])
      )
    )
    .digest('hex');
  return { units, aliases, movedAway, hash };
}

// ── Planner ─────────────────────────────────────────────────────

export const FOCUS_PLANNER_DIRECTIVE = `<slices_note>
Large hunks are split into slices at definition boundaries. A <slice> is part of a hunk: list its ID in "hunkIds" exactly like a hunk ID. A topic displays only the hunks and slices it lists, so list exactly the code each topic explains.
- Code that no topic lists is left out of the explanation. The reviewer sees it listed as code outside the explanation and can still read it in Changes. Leave out only code a reviewer does not need explained.
- A slice with "movedFrom" is the new copy of a definition moved from elsewhere in this change. Its old copy is explained with it and is not in the index.
</slices_note>`;

const attribute = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (lines: readonly LineRange[]) =>
  lines.length ? `${lines[0].start}-${lines[lines.length - 1].end}` : '';
/** The unit's first changed lines, for the planner to see what a slice holds. */
function excerpt(hunk: IndexedHunk, slice: HunkSlice, count = 3) {
  const lines = hunk.expandedContent.split('\n');
  const changed: string[] = [];
  for (const range of slice.lines)
    for (let i = range.start; i <= range.end && changed.length < count; i++)
      if (lines[i]?.startsWith('+') || lines[i]?.startsWith('-')) {
        const line = lines[i].replace(/\s+$/, '');
        changed.push(line.length > 100 ? `${line.slice(0, 99)}…` : line);
      }
  return changed.join('\n');
}

/** Where a unit is: `+12-40` for its new lines, else `-12-40` for its old lines. */
const where = (slice: HunkSlice) =>
  slice.newLines.length && slice.additions ? `+${span(slice.newLines)}` : `-${span(slice.oldLines)}`;

/** The moved definition's old place, for the planner and the writer. */
function moveSource(index: FocusIndex, unitId: string): (SliceMoveSource & { unit: FocusUnit }) | undefined {
  for (const [from, to] of index.movedAway) {
    if (to !== unitId) continue;
    const unit = index.units.get(from);
    if (!unit) continue;
    const symbol = unit.slice.symbols.find((s) => s.side === 'before');
    const lines = unit.slice.oldLines;
    return {
      unit,
      filePath: unit.filePath,
      startLine: symbol?.start ?? lines.at(0)?.start ?? 1,
      endLine: symbol?.end ?? lines.at(-1)?.end ?? 1,
      body: unit.slice.moveBody ?? index.units.get(to)?.slice.moveBody ?? 'edited',
    };
  }
  return undefined;
}

/**
 * The planner's hunk index with slices: a whole hunk keeps its `<hunk>` entry, and a sliced hunk is listed as its
 * slices, each with its symbol label, counts, lines and a short excerpt. A deleted slice covered by its move is not
 * listed; its new copy says where it came from.
 */
export function formatFocusIndexForPrompt(hunks: readonly IndexedHunk[], index: FocusIndex): string {
  const byId = new Map(hunks.map((hunk) => [hunk.id, hunk]));
  const entries: string[] = [];
  for (const unit of index.units.values()) {
    const hunk = byId.get(unit.hunkId);
    if (!hunk || index.movedAway.has(unit.id)) continue;
    const moved = moveSource(index, unit.id);
    const movedFrom = moved ? ` movedFrom="${attribute(`${moved.filePath}:${moved.startLine}-${moved.endLine}`)} (${moved.body})"` : '';
    if (unit.whole && !moved) {
      entries.push(formatHunkIndexForPrompt([hunk]).split('\n')[1]);
      continue;
    }
    entries.push(
      `  <slice id="${attribute(unit.id)}" hunk="${unit.hunkId}" file="${attribute(unit.filePath)}" label="${attribute(unit.slice.label)}" lines="${where(unit.slice)}" additions="${unit.slice.additions}" deletions="${unit.slice.deletions}"${movedFrom}>\n${attribute(excerpt(hunk, unit.slice))}\n  </slice>`
    );
  }
  return `${FOCUS_PLANNER_DIRECTIVE}\n<hunk_index>\n${entries.join('\n')}\n</hunk_index>`;
}

/** The planner's index: the hunk index when Focused sections is off (unchanged), else with slices. */
export function focusPlannerIndex(hunks: readonly IndexedHunk[], index: FocusIndex | undefined): string {
  return index ? formatFocusIndexForPrompt(hunks, index) : formatHunkIndexForPrompt([...hunks]);
}

/** A checkpoint identity with the slices' content hash when Focused sections is on; the same object when it's off. */
export function focusCheckpointKey<T extends object>(identity: T, index: FocusIndex | undefined): T | (T & { focusedSections: string }) {
  return index ? { ...identity, focusedSections: index.hash } : identity;
}

/**
 * The plan's IDs checked against the units: a unit's ID stays; a sliced hunk's ID becomes its slices; a whole hunk's
 * slice ID becomes the hunk's ID; a moved deleted slice becomes its new copy. Unknown IDs are dropped. Each topic lists
 * a unit once, in the planner's order.
 */
export function validateFocusTopics(topics: readonly TopicPlan[], index: FocusIndex): TopicPlan[] {
  return topics.map((topic) => {
    const ids = (Array.isArray(topic.hunkIds) ? topic.hunkIds : []).filter((id): id is string => typeof id === 'string');
    const resolved = ids
      .flatMap((id) => (index.units.has(id) ? [id] : (index.aliases.get(id) ?? [])))
      .map((id) => index.movedAway.get(id) ?? id)
      .filter((id) => index.units.has(id));
    return { ...topic, hunkIds: [...new Set(resolved)] };
  });
}

/** The planner's noise list without hunks that a topic lists part of: a hunk is cut whole or not at all. */
export function focusPlannerNoise(noise: unknown, topics: readonly TopicPlan[], index: FocusIndex): unknown {
  if (!Array.isArray(noise)) return noise;
  const listed = new Set(topics.flatMap((topic) => topic.hunkIds.map((id) => index.units.get(id)?.hunkId)));
  return noise.filter(
    (entry: unknown) => !(entry && typeof entry === 'object' && listed.has((entry as { hunkId?: string }).hunkId))
  );
}

/** The units of hunks left out as noise. */
export function focusCutUnits(index: FocusIndex, cut: ReadonlySet<string> | ReadonlyMap<string, unknown>): Set<string> {
  return new Set([...index.units.values()].filter((unit) => cut.has(unit.hunkId)).map((unit) => unit.id));
}

/**
 * Units no section shows and noise didn't cut. A moved deleted slice is covered by its move. When all of them together
 * have fewer than `FOCUS_OTHER_CHANGES_LINES` changed lines they go to "Other changes" (`other`); otherwise they are
 * left out of the explanation and listed (`outside`).
 */
export function focusLeftovers(
  index: FocusIndex,
  owners: ReadonlyMap<string, number>,
  cut: ReadonlySet<string>
): { other: string[]; outside: OutsideCode[] } {
  const left = [...index.units.values()].filter(
    (unit) => !owners.has(unit.id) && !cut.has(unit.id) && !index.movedAway.has(unit.id)
  );
  const lines = left.reduce((sum, unit) => sum + unit.slice.additions + unit.slice.deletions, 0);
  if (lines < FOCUS_OTHER_CHANGES_LINES) return { other: left.map((unit) => unit.id), outside: [] };
  const first = (code: OutsideCode) => code.newLines.at(0)?.start ?? code.oldLines.at(0)?.start ?? 0;
  return {
    other: [],
    outside: left
      .map((unit) => ({
        filePath: unit.filePath,
        id: unit.id,
        label: unit.slice.label,
        oldLines: unit.slice.oldLines,
        newLines: unit.slice.newLines,
        additions: unit.slice.additions,
        deletions: unit.slice.deletions,
      }))
      .sort((a, b) => a.filePath.localeCompare(b.filePath) || first(a) - first(b)),
  };
}

/** Each unit's hunk ID, once each in order: the writer's file contents and noise context work per hunk. */
export function unitHunkIds(ids: readonly string[], index: FocusIndex): string[] {
  return [...new Set(ids.flatMap((id) => index.units.get(id)?.hunkId ?? []))];
}

// ── Writer ──────────────────────────────────────────────────────

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Lines of a hunk cut to `ranges` (indexes into its content), each range with a header of its own. */
export function cutHunk(header: string, content: string, ranges: readonly LineRange[]): { header: string; content: string }[] {
  const match = HEADER.exec(header);
  const lines = content.split('\n');
  if (!match) return [{ header, content }];
  const out: { header: string; content: string }[] = [];
  for (const range of ranges) {
    let old = Number(match[1]) + (match[2] === '0' ? 1 : 0);
    let now = Number(match[3]) + (match[4] === '0' ? 1 : 0);
    for (let i = 0; i < range.start && i < lines.length; i++) {
      const marker = lines[i][0];
      if (marker === '-') old++;
      else if (marker === '+') now++;
      else if (marker !== '\\') {
        old++;
        now++;
      }
    }
    const body = lines.slice(range.start, range.end + 1);
    const oldCount = body.filter((line) => line[0] !== '+' && line[0] !== '\\').length;
    const newCount = body.filter((line) => line[0] !== '-' && line[0] !== '\\').length;
    out.push({ header: `@@ -${old},${oldCount} +${now},${newCount} @@`, content: body.join('\n') });
  }
  return out;
}

/** The unit's code as the section shows it: the whole hunk, or its slice's ranges. */
function unitCode(unit: FocusUnit, hunk: IndexedHunk, expanded: boolean) {
  if (unit.whole) return `${expanded ? hunk.expandedHunkHeader : hunk.hunkHeader}\n${expanded ? hunk.expandedContent : hunk.content}`;
  return cutHunk(hunk.expandedHunkHeader, hunk.expandedContent, unit.slice.lines)
    .map((part) => `${part.header}\n${part.content}`)
    .join('\n');
}

const text = (files: Record<string, string>, path: string) => (Object.hasOwn(files, path) ? files[path] : undefined);
const lineOf = (source: string | undefined, line: number) => source?.split('\n')[line - 1]?.trim();

/** The definitions a slice holds or sits in, by label with their first source line. */
function signatures(unit: FocusUnit, before: Record<string, string>, after: Record<string, string>): string[] {
  return unit.slice.symbols.flatMap((symbol) => {
    if (!symbol.kind) return [];
    const signature = lineOf(text(symbol.side === 'before' ? before : after, unit.filePath), symbol.start);
    if (!signature) return [`- ${symbol.label}`];
    return [`- ${symbol.label}: \`${signature.length > 160 ? `${signature.slice(0, 159)}…` : signature}\``];
  });
}

function bodyOf(source: string | undefined, start: number, end: number) {
  return (source ?? '').split('\n').slice(start - 1, end).join('\n') + '\n';
}

/**
 * A focused writer's code (#562): the `<diff_hunks>` it explains, exactly the code its section shows, with the
 * definitions around each slice and where a moved definition came from; then the units it lists that an earlier
 * section shows, as read-only context. It replaces buildTopicContext's hunk blocks.
 */
export function focusedTopicDiff(
  owned: readonly string[],
  elsewhere: ReadonlyMap<string, number>,
  index: FocusIndex,
  hunkMap: ReadonlyMap<string, IndexedHunk>,
  before: Record<string, string>,
  after: Record<string, string>
): string {
  let ctx = `<diff_hunks>
Your section displays exactly the code below, and nothing else from these files. Explain only this code. A slice is part of a larger hunk: the rest of that hunk is shown in another section or left out of the explanation.

`;
  for (const id of owned) {
    const unit = index.units.get(id);
    const hunk = unit && hunkMap.get(unit.hunkId);
    if (!unit || !hunk) continue;
    ctx += `--- ${hunk.filePath} (${hunk.fileStatus}) [${unit.id}]${unit.whole ? '' : ` ${unit.slice.label}`}\n`;
    const around = unit.whole ? [] : signatures(unit, before, after);
    if (around.length) ctx += `Definitions:\n${around.join('\n')}\n`;
    ctx += `${unitCode(unit, hunk, true)}\n`;
    const moved = moveSource(index, unit.id);
    if (moved) {
      ctx += `Moved from ${moved.filePath} (old lines ${moved.startLine}-${moved.endLine}). Explain it as a move, on this new copy; the old copy is not shown.`;
      if (moved.body === 'identical') ctx += ' Its body is unchanged.\n';
      else {
        const newSymbol = unit.slice.symbols.find((s) => s.side === 'after');
        const newStart = newSymbol?.start ?? unit.slice.newLines.at(0)?.start ?? 1;
        const newEnd = newSymbol?.end ?? unit.slice.newLines.at(-1)?.end ?? newStart;
        const patch = createTwoFilesPatch(
          moved.filePath,
          unit.filePath,
          bodyOf(text(before, moved.filePath), moved.startLine, moved.endLine),
          bodyOf(text(after, unit.filePath), newStart, newEnd),
          '',
          '',
          { context: 3 }
        );
        ctx += ` It was edited during the move; the edits against the old body:\n${patch.slice(Math.max(0, patch.indexOf('@@'))).trimEnd()}\n`;
      }
    }
    ctx += '\n';
  }
  ctx += '</diff_hunks>';
  const shown = [...new Set(elsewhere.keys())].filter((id) => index.units.has(id));
  if (shown.length) {
    ctx += `\n\n<shown_in_other_sections>
Your section displays only the code in <diff_hunks>. This code is displayed in an earlier section, which explains it. Use it only as read-only context: do not explain it, and do not anchor notes or checks to it. Refer to it by section number when needed.
When the narrative brief asks for code listed here, refer to it by its section number; do not explain or quote it.
`;
    for (const id of shown) {
      const unit = index.units.get(id);
      const hunk = unit && hunkMap.get(unit.hunkId);
      if (!unit || !hunk) continue;
      ctx += `--- ${hunk.filePath} [${unit.id}]${unit.whole ? '' : ` ${unit.slice.label}`} (shown in section ${elsewhere.get(id)})\n${unitCode(unit, hunk, false)}\n\n`;
    }
    ctx += '</shown_in_other_sections>';
  }
  return ctx;
}

// ── Slides ──────────────────────────────────────────────────────

/**
 * The slide entries for units: a whole hunk as today; a slice as its whole hunk with the slice's `lineRanges`, ID and
 * label, so the slide renders correctly before ranges are drawn (#563). A moved definition's new copy says where it came from.
 */
export function focusDiffHunks(
  ids: readonly string[],
  index: FocusIndex,
  hunkMap: ReadonlyMap<string, IndexedHunk>
): DiffHunk[] {
  return ids.flatMap((id) => {
    const unit = index.units.get(id);
    if (!unit) return [];
    const entry = resolveDiffHunks([unit.hunkId], hunkMap)[0] as DiffHunk | undefined;
    if (!entry) return [];
    const moved = moveSource(index, unit.id);
    return [
      {
        ...entry,
        ...(unit.whole ? {} : { lineRanges: unit.slice.lines.map((r) => ({ ...r })), sliceId: unit.id, label: unit.slice.label }),
        ...(moved
          ? { movedFrom: { filePath: moved.filePath, startLine: moved.startLine, endLine: moved.endLine, body: moved.body } }
          : {}),
      },
    ];
  });
}
