import { parseDocument } from 'yaml';
import type { WorkflowDefinitionJob, WorkflowJob, WorkflowGraphNode } from '../lib/workflow-graph';

type Scalar = string | number | boolean;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const scalar = (v: unknown): v is Scalar => ['string', 'number', 'boolean'].includes(typeof v);

/** Resolve data references only. Never evaluate GitHub expressions or execute workflow code. */
function interpolate(value: unknown, context: Record<string, unknown>): string | undefined {
  if (!scalar(value)) return;
  const result = String(value).replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (match: string, expression: string) => {
    const keys = expression.trim().split('.');
    let found: unknown = context;
    for (const key of keys) found = record(found) ? found[key] : undefined;
    if (!scalar(found)) return match;
    return String(found);
  });
  return result.includes('${{') ? undefined : result;
}
function matrices(value: unknown): Record<string, unknown>[] {
  if (!record(value)) return [];
  let combinations: Record<string, unknown>[] = [{}];
  for (const [key, values] of Object.entries(value)) {
    if (key === 'include' || key === 'exclude') continue;
    if (!Array.isArray(values) || values.length > 256) return [];
    combinations = combinations.flatMap((item) => values.map((v: unknown) => ({ ...item, [key]: v })));
    if (combinations.length > 256) return [];
  }
  const excludes = Array.isArray(value.exclude) ? value.exclude.filter(record) : [];
  combinations = combinations.filter(
    (item) =>
      !excludes.some((ex) => Object.keys(ex).every((key) => JSON.stringify(item[key]) === JSON.stringify(ex[key])))
  );
  if (!Object.keys(value).some((key) => key !== 'include' && key !== 'exclude')) combinations = [];
  const originals = combinations;
  if (Array.isArray(value.include)) {
    for (const addition of value.include.filter(record)) {
      const indices = originals.flatMap((original, i) =>
        Object.keys(addition).some(
          (key) => key in original && JSON.stringify(original[key]) !== JSON.stringify(addition[key])
        )
          ? []
          : [i]
      );
      if (indices.length)
        combinations = combinations.map((item, i) => (indices.includes(i) ? { ...item, ...addition } : item));
      else combinations = [...combinations, addition];
    }
  }
  return combinations.slice(0, 256);
}
export function parseWorkflow(source: string, inputs: Record<string, Scalar> = {}): WorkflowDefinitionJob[] {
  if (Buffer.byteLength(source) > 512_000) throw Error('Workflow definition is too large to visualize.');
  const document = parseDocument(source, { uniqueKeys: true, strict: true });
  if (document.errors.length) throw Error('Workflow YAML could not be parsed.');
  const value: unknown = document.toJS({ maxAliasCount: 50 });
  if (!record(value) || !record(value.jobs)) throw Error('Workflow has no job definitions.');
  const defaults =
    record(value.on) && record(value.on.workflow_call) && record(value.on.workflow_call.inputs)
      ? value.on.workflow_call.inputs
      : {};
  const resolvedInputs: Record<string, Scalar> = { ...inputs };
  for (const [key, definition] of Object.entries(defaults))
    if (!(key in resolvedInputs) && record(definition) && scalar(definition.default))
      resolvedInputs[key] = definition.default;
  if (Object.keys(value.jobs).length > 300) throw Error('Workflow has too many job definitions to visualize.');
  return Object.entries(value.jobs)
    .filter(([, job]) => record(job))
    .map(([id, raw]) => {
      const job = raw as Record<string, unknown>;
      const matrix = record(job.strategy) && 'matrix' in job.strategy;
      const variants = matrix ? matrices((job.strategy as Record<string, unknown>).matrix) : [{}];
      const names = variants.flatMap((variant) => {
        const name = interpolate(job.name ?? id, { matrix: variant, inputs: resolvedInputs });
        // GitHub adds matrix values to the default job name, but not a custom name.
        return name ? [matrix && !job.name ? `${name} (${Object.values(variant).join(', ')})` : name] : [];
      });
      const childInputs: Record<string, Scalar> = {};
      if (record(job.with))
        for (const [key, v] of Object.entries(job.with)) {
          const result = interpolate(v, { inputs: resolvedInputs });
          if (result !== undefined) childInputs[key] = result;
        }
      return {
        id,
        name: interpolate(job.name, { inputs: resolvedInputs }) ?? id,
        names: [...new Set(names)],
        matrix,
        needs: (Array.isArray(job.needs) ? job.needs : [job.needs]).filter((v): v is string => typeof v === 'string'),
        ...(typeof job.uses === 'string' ? { uses: job.uses, inputs: childInputs } : {}),
      };
    });
}

/** Build only declared edges. Ambiguous or dynamic name matches stay disconnected. */
export function assembleWorkflow(definitions: WorkflowDefinitionJob[], jobs: WorkflowJob[], expanded: string[]) {
  const nodes: WorkflowGraphNode[] = [],
    edges: { id: string; source: string; target: string }[] = [],
    groups: { id: string; name: string }[] = [];
  const claimed = new Set<number>();
  const leaves: { id: string; definition: WorkflowDefinitionJob; names: string[]; group?: string; groupId?: string }[] =
    [];
  function gather(defs: WorkflowDefinitionJob[], prefix = '', namePrefixes = [''], group?: string, groupId?: string) {
    for (const def of defs) {
      const id = prefix + def.id;
      const names = namePrefixes.flatMap((p) => def.names.map((n) => p + n));
      if (def.children?.length)
        gather(
          def.children,
          id + '/',
          names.map((n) => n + ' / '),
          def.name,
          id
        );
      else leaves.push({ id, definition: def, names, group, groupId });
    }
  }
  gather(definitions);
  const matches = new Map<string, WorkflowJob[]>();
  for (const job of jobs) {
    const candidates = leaves.filter((leaf) => leaf.names.includes(job.name));
    if (candidates.length === 1) {
      const id = candidates[0].id;
      matches.set(id, [...(matches.get(id) ?? []), job]);
      claimed.add(job.id);
    }
  }
  const edge = (source: string, target: string) => {
    if (source !== target) edges.push({ id: `${source}->${target}`, source, target });
  };
  function build(
    defs: WorkflowDefinitionJob[],
    prefix = '',
    group?: string,
    groupId?: string
  ): { entries: string[]; exits: string[] } {
    const endpoints = new Map<string, { entries: string[]; exits: string[] }>();
    for (const def of defs) {
      const id = prefix + def.id;
      const children = leaves
        .filter((leaf) => leaf.id === id || leaf.id.startsWith(id + '/'))
        .flatMap((leaf) => matches.get(leaf.id) ?? []);
      const expandable = !!def.children?.length || children.length > 1;
      if (expandable) groups.push({ id, name: def.name });
      if (expandable && expanded.includes(id)) {
        if (def.children?.length) endpoints.set(def.id, build(def.children, id + '/', def.name, id));
        else {
          const ids = children.map((job) => {
            const childId = `${id}/job:${job.id}`;
            nodes.push({
              id: childId,
              name: job.name,
              jobs: [job],
              group: def.name,
              groupId: id,
              definition: id,
              x: 0,
              y: 0,
            });
            return childId;
          });
          endpoints.set(def.id, { entries: ids, exits: ids });
        }
      } else {
        nodes.push({ id, name: def.name, jobs: children, expandable, definition: id, group, groupId, x: 0, y: 0 });
        endpoints.set(def.id, { entries: [id], exits: [id] });
      }
    }
    for (const def of defs)
      for (const dependency of def.needs) {
        for (const source of endpoints.get(dependency)?.exits ?? [])
          for (const target of endpoints.get(def.id)?.entries ?? []) edge(source, target);
      }
    const dependedOn = new Set(defs.flatMap((d) => d.needs));
    return {
      entries: defs
        .filter((d) => !d.needs.some((n) => endpoints.has(n)))
        .flatMap((d) => endpoints.get(d.id)?.entries ?? []),
      exits: defs.filter((d) => !dependedOn.has(d.id)).flatMap((d) => endpoints.get(d.id)?.exits ?? []),
    };
  }
  build(definitions);
  for (const job of jobs)
    if (!claimed.has(job.id))
      nodes.push({ id: `unmapped:${job.id}`, name: job.name, jobs: [job], unmapped: true, x: 0, y: 0 });
  return { nodes, edges, groups, unmatched: jobs.length - claimed.size };
}
