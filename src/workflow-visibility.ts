import { createHash } from 'node:crypto';
import type { WorkflowGraph, WorkflowGraphNode, WorkflowGraphInput } from '../lib/workflow-graph';

/** Compact only equivalent parallel nodes. Never invent a path through unrelated jobs. */
export function compactWorkflow(
  nodes: WorkflowGraphNode[],
  edges: WorkflowGraph['edges'],
  options: Pick<WorkflowGraphInput, 'showSkipped' | 'showCompleted'>
) {
  const groups = new Map<string, { kind: 'skipped' | 'completed'; members: WorkflowGraphNode[] }>();
  const replacements = new Map<string, string>();
  const visible: WorkflowGraphNode[] = [];
  for (const node of nodes) {
    const kind =
      node.jobs.length && node.jobs.every((job) => job.status === 'completed' && job.conclusion === 'skipped')
        ? 'skipped'
        : node.jobs.length &&
            node.jobs.every(
              (job) => job.status === 'completed' && ['success', 'neutral'].includes(job.conclusion ?? '')
            )
          ? 'completed'
          : undefined;
    if (!kind || (kind === 'skipped' ? options.showSkipped !== false : options.showCompleted !== false)) {
      visible.push(node);
      continue;
    }
    const incoming = edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => edge.source)
      .sort();
    const outgoing = edges
      .filter((edge) => edge.source === node.id)
      .map((edge) => edge.target)
      .sort();
    const key = JSON.stringify([kind, !!node.unmapped, incoming, outgoing]);
    const group = groups.get(key) ?? { kind, members: [] };
    group.members.push(node);
    groups.set(key, group);
  }
  for (const { kind, members } of groups.values()) {
    const id = `collapsed:${createHash('sha256')
      .update(JSON.stringify(members.map((node) => node.id).sort()))
      .digest('hex')}`;
    const jobs = members.flatMap((node) => node.jobs);
    visible.push({
      id,
      name: `${jobs.length} ${kind} ${jobs.length === 1 ? 'job' : 'jobs'}`,
      jobs,
      x: 0,
      y: 0,
      height: 48,
      collapsed: kind,
      unmapped: members[0].unmapped,
    });
    for (const node of members) replacements.set(node.id, id);
  }
  const routed = new Map<string, WorkflowGraph['edges'][number]>();
  for (const edge of edges) {
    const source = replacements.get(edge.source) ?? edge.source;
    const target = replacements.get(edge.target) ?? edge.target;
    const id = createHash('sha256')
      .update(JSON.stringify([source, target]))
      .digest('hex');
    routed.set(id, { id, source, target });
  }
  // Preserve IDs and positions when all jobs are visible.
  return groups.size ? { nodes: visible, edges: [...routed.values()] } : { nodes, edges };
}
