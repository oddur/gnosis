import type { MechanismScene } from './mechanism';
export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 196;
export interface Point {
  x: number;
  y: number;
}
/** Geometry depends only on the scene, never its current event or values. */
export function layoutMechanism(scene: MechanismScene, nodeHeight = NODE_HEIGHT, compact = false) {
  const ordered = [...scene.nodes].sort((a, b) => a.row - b.row || a.column - b.column);
  const placements = compact ? ordered.map((n, i) => ({ ...n, column: i % 2, row: Math.floor(i / 2) })) : scene.nodes;
  const columns = Math.max(...placements.map((n) => n.column)) + 1;
  const nodes = placements.map((n) => ({ ...n, x: 24 + n.column * 292, y: 24 + n.row * (nodeHeight + 104) }));
  const edges = scene.edges.map((e, i) => {
    const from = nodes.find((n) => n.id === e.from);
    const to = nodes.find((n) => n.id === e.to);
    if (!from || !to) throw new Error('Invalid mechanism edge');
    let points: Point[];
    if (from.row === to.row && Math.abs(from.column - to.column) === 1) {
      const right = to.column > from.column;
      // Separate opposite-direction connections and their labels.
      const reverse = scene.edges.some((other) => other.from === e.to && other.to === e.from);
      const y = from.y + nodeHeight * (reverse ? (right ? 0.35 : 0.75) : 0.55);
      points = [
        { x: from.x + (right ? NODE_WIDTH : 0), y },
        { x: to.x + (right ? 0 : NODE_WIDTH), y },
      ];
    } else if (Math.abs(from.row - to.row) > 1) {
      const gutter = 48 + columns * NODE_WIDTH + (columns - 1) * 72 + i * 12;
      points = [
        { x: from.x + NODE_WIDTH, y: from.y + nodeHeight / 2 },
        { x: gutter, y: from.y + nodeHeight / 2 },
        { x: gutter, y: to.y + nodeHeight / 2 },
        { x: to.x + NODE_WIDTH, y: to.y + nodeHeight / 2 },
      ];
    } else {
      const down = to.row > from.row;
      const fromY = from.y + (down || from.row === to.row ? nodeHeight : 0);
      const toY = from.row === to.row ? to.y + nodeHeight : down ? to.y : to.y + nodeHeight;
      const gutter = from.row === to.row ? fromY + 38 + i * 7 : down ? fromY + 48 + i * 5 : toY + 48 + i * 5;
      points = [
        { x: from.x + NODE_WIDTH * 0.65, y: fromY },
        { x: from.x + NODE_WIDTH * 0.65, y: gutter },
        { x: to.x + NODE_WIDTH * 0.35, y: gutter },
        { x: to.x + NODE_WIDTH * 0.35, y: toY },
      ];
    }
    const middle = pointOnRoute(points, 0.5);
    return {
      ...e,
      points,
      path: points.map((p, j) => `${j ? 'L' : 'M'}${p.x},${p.y}`).join(' '),
      labelPosition: middle,
    };
  });
  return {
    nodes,
    edges,
    width: Math.max(
      48 + columns * NODE_WIDTH + (columns - 1) * 72,
      ...edges.flatMap((e) => e.points.map((p) => p.x + 24))
    ),
    height: Math.max(
      ...nodes.map((n) => n.y + nodeHeight + 24),
      ...edges.flatMap((e) => e.points.map((p) => p.y + 40))
    ),
  };
}
export function pointOnRoute(points: Point[], progress: number): Point {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  let remaining = lengths.reduce((a, b) => a + b, 0) * Math.max(0, Math.min(1, progress));
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i]) {
      const t = lengths[i] ? remaining / lengths[i] : 0;
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t,
      };
    }
    remaining -= lengths[i];
  }
  return points[points.length - 1];
}
