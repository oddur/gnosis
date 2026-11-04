import { createHash } from 'node:crypto';
import type { WorkflowGraph, WorkflowGraphNode, WorkflowGrouping } from '../lib/workflow-graph';

/** Equal predecessor/successor sets are parallel work, not an inferred dependency. */
export function stageWorkflow(
  nodes: WorkflowGraphNode[],
  edges: WorkflowGraph['edges'],
  expanded: string[],
  grouping: WorkflowGrouping = 'adaptive'
) {
  if (grouping === 'off') return { nodes, edges, groups: [] };
  const candidates = new Map<string, WorkflowGraphNode[]>();
  for (const node of nodes) {
    // Explicit YAML groups are separate. Never hide work that needs attention
    // inside an inferred parallel stage, including mixed or unreported groups.
    if (
      node.unmapped ||
      node.groupId ||
      !node.jobs.length ||
      node.jobs.some(
        (job) => job.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(job.conclusion ?? '')
      )
    )
      continue;
    const incoming = edges
      .filter((e) => e.target === node.id)
      .map((e) => e.source)
      .sort();
    const outgoing = edges
      .filter((e) => e.source === node.id)
      .map((e) => e.target)
      .sort();
    // Disconnected jobs have no evidence of belonging to the same stage.
    if (!incoming.length && !outgoing.length) continue;
    const key = JSON.stringify([incoming, outgoing]);
    candidates.set(key, [...(candidates.get(key) ?? []), node]);
  }
  const replacements = new Map<string, string>();
  const summaries: WorkflowGraphNode[] = [];
  const groups: WorkflowGraph['groups'] = [];
  const minimum = grouping === 'compact' ? 3 : 6;
  // Choose the largest reductions first. Plan before applying manual expansion,
  // so expanding one stage never makes another stage unexpectedly collapse.
  let visible = nodes.length;
  const ordered = [...candidates.entries()].sort(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b));
  for (const [, members] of ordered) {
    if (members.length < minimum || (grouping === 'adaptive' && visible <= 16)) continue;
    visible -= members.length - 1;
    const id = `stage:${createHash('sha256')
      .update(JSON.stringify(members.map((n) => n.id).sort()))
      .digest('hex')}`;
    const name = `${members.length} parallel jobs`;
    groups.push({ id, name });
    if (expanded.includes(id)) continue;
    summaries.push({
      id,
      name,
      x: 0,
      y: 0,
      jobs: members.flatMap((n) => n.jobs),
      height: 136,
      expandable: true,
      stage: {
        count: members.length,
        names: members.map((n) => n.name),
        unreported: members.filter((n) => !n.jobs.length).length,
      },
    });
    for (const member of members) replacements.set(member.id, id);
  }
  const unique = new Map<string, WorkflowGraph['edges'][number]>();
  for (const edge of edges) {
    const source = replacements.get(edge.source) ?? edge.source;
    const target = replacements.get(edge.target) ?? edge.target;
    const id = replacements.size
      ? createHash('sha256')
          .update(JSON.stringify([source, target]))
          .digest('hex')
      : edge.id;
    unique.set(id, { id, source, target });
  }
  return {
    nodes: [...nodes.filter((n) => !replacements.has(n.id)), ...summaries],
    edges: [...unique.values()],
    groups,
  };
}

/** Follow ancestors and descendants separately: do not pull in siblings through a shared parent. */
export function focusWorkflow(nodes: WorkflowGraphNode[], edges: WorkflowGraph['edges'], focusId?: string) {
  const focus = nodes.find((n) => n.id === focusId);
  if (!focus) return { nodes, edges };
  const visible = new Set([focus.id]);
  for (const direction of ['ancestors', 'descendants']) {
    const visited = new Set([focus.id]);
    const queue = [focus.id];
    for (let i = 0; i < queue.length; i++)
      for (const edge of edges) {
        const next =
          direction === 'ancestors' ? edge.target === queue[i] && edge.source : edge.source === queue[i] && edge.target;
        if (next && !visited.has(next)) {
          visited.add(next);
          visible.add(next);
          queue.push(next);
        }
      }
  }
  return {
    nodes: nodes
      .filter((n) => visible.has(n.id))
      .map((node) => {
        const outsideIds = new Set(
          edges.filter((e) => e.target === node.id && !visible.has(e.source)).map((e) => e.source)
        );
        const outsidePrerequisites = nodes
          .filter((n) => outsideIds.has(n.id))
          .map(({ id, name, jobs }) => ({ id, name, jobs }));
        return outsidePrerequisites.length ? { ...node, outsidePrerequisites } : node;
      }),
    edges: edges.filter((e) => visible.has(e.source) && visible.has(e.target)),
    focus: { id: focus.id, name: focus.name },
  };
}
