import type { WorkflowGraph } from './workflow-graph';
/** Never shrink text to make a large graph fit. Anchor its entry (or focused job) instead. */
export function readableWorkflowViewport(
  graph: Pick<WorkflowGraph, 'nodes' | 'edges' | 'focus'>,
  width: number,
  height: number
) {
  if (!graph.nodes.length) return { x: 24, y: 24, zoom: 1 };
  const minX = Math.min(...graph.nodes.map((n) => n.x)),
    minY = Math.min(...graph.nodes.map((n) => n.y));
  const maxX = Math.max(...graph.nodes.map((n) => n.x + 244)),
    maxY = Math.max(...graph.nodes.map((n) => n.y + (n.height ?? 112)));
  const connected = new Set(graph.edges.flatMap((e) => [e.source, e.target]));
  const focus = graph.nodes.find((n) => n.id === graph.focus?.id);
  const entry =
    focus ??
    [...graph.nodes].sort(
      (a, b) => Number(connected.has(b.id)) - Number(connected.has(a.id)) || a.x - b.x || a.y - b.y
    )[0];
  return {
    x:
      maxX - minX + 24 <= width
        ? (width - (maxX - minX)) / 2 - minX
        : focus
          ? (width - 244) / 2 - focus.x
          : 24 - entry.x,
    y:
      maxY - minY + 24 <= height
        ? (height - (maxY - minY)) / 2 - minY
        : focus
          ? Math.max(24, (height - (focus.height ?? 112)) / 2) - focus.y
          : 24 - minY,
    zoom: 1,
  };
}
