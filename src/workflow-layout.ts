import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { WorkflowPort } from '../lib/workflow-graph';
const elk = new ELK();
/** Position cards and route their edges together; the renderer must preserve both. */
export async function layoutWorkflow(
  nodes: { id: string; height?: number }[],
  edges: { id: string; source: string; target: string }[]
) {
  const ports = new Map<string, WorkflowPort[]>();
  for (const node of nodes) {
    const result: WorkflowPort[] = [];
    for (const side of ['source', 'target'] as const) {
      const connections = edges.filter((e) => e[side] === node.id);
      connections.forEach((edge, i) =>
        result.push({
          id: `${side}:${edge.id}`,
          type: side,
          x: side === 'source' ? 244 : 0,
          y: 16 + ((i + 1) * ((node.height ?? 112) - 32)) / (connections.length + 1),
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
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
      ports: (ports.get(node.id) ?? []).map((port) => ({
        id: port.id,
        x: port.x,
        y: port.y,
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
      x: node.x ?? 0,
      y: node.y ?? 0,
      ports: ports.get(node.id) ?? [],
    })),
    edges: (result.edges ?? []).map((edge) => {
      const section = edge.sections?.[0];
      if (!section) throw Error('A workflow connection could not be routed. Use List view or retry.');
      return { id: edge.id, points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint] };
    }),
  };
}
