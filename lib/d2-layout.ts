import type { CompileResponse, D2, Diagram, Text } from '@d2lang/d2';

type Board = { diagram: Diagram; path: string };
const quote = (value: string) => JSON.stringify(value).replace(/\$/g, '\\$');
const byId = <T extends { id: string }>(values: T[]) => [...values].sort((a, b) => a.id.localeCompare(b.id));

/** Only share geometry when the drawing still represents the same graph. */
function structure(board: Diagram): string {
  return JSON.stringify([
    board.root.type,
    byId(board.shapes).map((s) => [
      s.id,
      s.type,
      s.icon,
      s.iconPosition,
      'language' in s ? s.language : undefined,
      'fields' in s ? s.fields : undefined,
      'methods' in s ? s.methods : undefined,
      'columns' in s ? s.columns : undefined,
    ]),
    byId(board.connections).map((e) => [e.id, e.src, e.dst, e.srcArrow, e.dstArrow, e.srcLabel, e.dstLabel, e.icon]),
  ]);
}

/** A private layout label reserves both the widest and tallest saved state.
 * It is never rendered: each board keeps its original label and text metrics.
 */
function reservedLabel(values: Text[]): string {
  const widest = values.reduce((a, b) => (b.labelWidth > a.labelWidth ? b : a));
  const height = Math.max(...values.map((v) => v.labelHeight));
  const lineHeight = widest.labelHeight / Math.max(1, widest.label.split('\n').length);
  const extra = lineHeight > 0 ? Math.ceil((height - widest.labelHeight) / lineHeight) : 0;
  return widest.label + '\n.'.repeat(Math.max(0, extra));
}

function reservation(boards: Diagram[]): string {
  const reference = boards[0];
  const declarations: string[] = [];
  for (const shape of reference.shapes) {
    const variants = boards.map((b) => b.shapes.find((s) => s.id === shape.id) ?? shape);
    const labels = variants.flatMap((s) => ('label' in s ? [s] : []));
    // Compound shapes retain their fields. Their compiled dimensions already
    // include internal rows, icons, container padding, and sequence notes.
    declarations.push(`${shape.id}.width: ${Math.max(...variants.map((s) => s.width))}`);
    declarations.push(`${shape.id}.height: ${Math.max(...variants.map((s) => s.height))}`);
    if (labels.length && labels.every((s) => !s.language)) {
      declarations.push(`${shape.id}.label: ${quote(reservedLabel(labels))}`);
    }
  }
  for (const edge of reference.connections) {
    // Sequence lifelines are compiler-generated, not editable source edges.
    if (!reference.shapes.some((s) => s.id === edge.src) || !reference.shapes.some((s) => s.id === edge.dst)) continue;
    const labels = boards.map((b) => b.connections.find((e) => e.id === edge.id) ?? edge);
    declarations.push(`${edge.id}.label: ${quote(reservedLabel(labels))}`);
  }
  return declarations.join('\n');
}

function copyGeometry(from: Diagram, to: Diagram) {
  const shapes = new Map(from.shapes.map((s) => [s.id, s]));
  const edges = new Map(from.connections.map((e) => [e.id, e]));
  for (const target of to.shapes) {
    const source = shapes.get(target.id);
    if (!source) continue;
    target.pos = { ...source.pos };
    target.width = source.width;
    target.height = source.height;
    target.labelPosition = source.labelPosition;
    target.iconPosition = source.iconPosition;
  }
  for (const target of to.connections) {
    const source = edges.get(target.id);
    if (!source) continue;
    target.route = structuredClone(source.route);
    target.isCurve = source.isCurve;
    target.labelPosition = source.labelPosition;
    target.labelPercentage = source.labelPercentage;
  }
  to.root.pos = { ...from.root.pos };
  to.root.width = from.root.width;
  to.root.height = from.root.height;
}

/** Compile one space-reserving layout per unchanged graph, then apply only its
 * geometry. This also repairs old saved native steps without rewriting them.
 * All extra layout work stays in D2's worker, before any frame is displayed.
 */
export async function stabilizeD2Layouts(d2: Pick<D2, 'compile'>, source: string, compiled: CompileResponse) {
  const root = compiled.diagram;
  const boards: Board[] = [{ diagram: root, path: '' }];
  for (const kind of ['steps', 'scenarios'] as const) {
    for (const diagram of root[kind] ?? []) {
      if (diagram) boards.push({ diagram, path: `${kind}.${quote(diagram.name)}.` });
    }
  }
  // The viewer rejects these structures itself; do not amplify invalid input.
  if (
    boards.length > 12 ||
    root.layers?.length ||
    boards.slice(1).some(({ diagram: b }) => b.steps?.length || b.scenarios?.length || b.layers?.length)
  )
    return compiled;
  const groups = new Map<string, Board[]>();
  for (const board of boards) {
    if (board.diagram.isFolderOnly) continue;
    const key = structure(board.diagram);
    const group = groups.get(key) ?? [];
    group.push(board);
    groups.set(key, group);
  }
  const shared = [...groups.values()].filter((group) => group.length > 1);
  if (!shared.length) return compiled;
  let name = '__gnosis_layout';
  while (boards.some((b) => b.diagram.name === name)) name += '_';
  const additions = shared.map(
    (group) => `${group[0].path}scenarios.${quote(name)}: {\n${reservation(group.map((b) => b.diagram))}\n}`
  );
  let reserved: CompileResponse;
  try {
    reserved = await d2.compile(`${source}\n${additions.join('\n')}`, { layout: 'tala' });
  } catch {
    // An unsupported compiler sizing constraint must not hide a saved diagram.
    return compiled;
  }
  for (const group of shared) {
    const first = group[0];
    const parent = first.path.startsWith('steps.')
      ? reserved.diagram.steps?.find((b) => b?.name === first.diagram.name)
      : first.path.startsWith('scenarios.')
        ? reserved.diagram.scenarios?.find((b) => b?.name === first.diagram.name)
        : reserved.diagram;
    const layout = parent?.scenarios?.find((b) => b?.name === name);
    if (!layout || structure(layout) !== structure(first.diagram)) continue;
    for (const { diagram } of group) copyGeometry(layout, diagram);
  }
  return compiled;
}

/** Shared geometry identifies a stable canvas, independently of board names. */
export function d2LayoutKey(board: Diagram): string {
  return JSON.stringify([
    byId(board.shapes).map((s) => [s.id, s.pos, s.width, s.height]),
    byId(board.connections).map((e) => [e.id, e.route]),
  ]);
}
