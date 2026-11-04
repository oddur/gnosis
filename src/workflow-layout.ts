import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { WorkflowPort } from '../lib/workflow-graph';
const elk = new ELK();
// Binary subpixels preserve orthogonal alignment and round-trip through JSON (including -0).
const coordinate = (value = 0) => Math.round(value * 64) / 64 || 0;
/** Position cards and route their edges together; the renderer must preserve both. */
export async function layoutWorkflow(
  nodes: { id: string; height?: number }[],
  edges: { id: string; source: string; target: string }[]
) {
  const ports = new Map<string, Pick<WorkflowPort, 'id' | 'type'>[]>();
  for (const node of nodes) {
    const result: Pick<WorkflowPort, 'id' | 'type'>[] = [];
    for (const side of ['source', 'target'] as const) {
      const connections = edges.filter((e) => e[side] === node.id);
      connections.forEach((edge) =>
        result.push({
          id: `${side}:${edge.id}`,
          type: side,
        })
      );
    }
    ports.set(node.id, result);
  }
  const result = await elk.layout<ElkNode>({
    id: 'workflow',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '28',
      'elk.spacing.edgeNode': '16',
      'elk.spacing.edgeEdge': '12',
      'elk.layered.spacing.nodeNodeBetweenLayers': '62',
      'elk.layered.spacing.edgeNodeBetweenLayers': '16',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
      'elk.layered.mergeEdges': 'false',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: 244,
      height: node.height ?? 112,
      // Keep inputs on the left and outputs on the right, but let crossing minimization
      // order the ports instead of pinning them to the YAML edge enumeration.
      layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE' },
      ports: (ports.get(node.id) ?? []).map((port) => ({
        id: port.id,
        width: 0,
        height: 0,
        layoutOptions: { 'elk.port.side': port.type === 'source' ? 'EAST' : 'WEST' },
      })),
    })),
    edges: edges.map((edge) => ({ id: edge.id, sources: [`source:${edge.id}`], targets: [`target:${edge.id}`] })),
  });
  return {
    nodes: (result.children ?? []).map((node) => ({
      id: node.id,
      x: coordinate(node.x),
      y: coordinate(node.y),
      ports: (node.ports ?? []).map(
        (port): WorkflowPort => ({
          id: port.id,
          type: port.id.startsWith('source:') ? 'source' : 'target',
          x: coordinate((node.x ?? 0) + (port.x ?? 0)) - coordinate(node.x),
          y: coordinate((node.y ?? 0) + (port.y ?? 0)) - coordinate(node.y),
        })
      ),
    })),
    edges: (result.edges ?? []).map((edge) => {
      const section = edge.sections?.[0];
      if (!section) throw Error('A workflow connection could not be routed. Use List view or retry.');
      return {
        id: edge.id,
        points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((point) => ({
          x: coordinate(point.x),
          y: coordinate(point.y),
        })),
      };
    }),
  };
}
