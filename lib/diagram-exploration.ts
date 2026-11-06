import type { MechanismEvidence } from './mechanism';

/** Semantics accompany authored SVG geometry; they do not prescribe a node layout. */
export interface DiagramExploration {
  kind: 'architecture' | 'component' | 'sequence' | 'dataflow';
  entities: {
    id: string;
    label: string;
    summary: string;
    change: 'changed' | 'context';
    evidence?: MechanismEvidence;
  }[];
  relationships: {
    id: string;
    from: string;
    to: string;
    label: string;
    summary: string;
    evidence?: MechanismEvidence;
  }[];
}

export interface DiagramEntityBounds {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max;
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z][\w-]{0,59}$/.test(v);
function evidence(v: unknown): MechanismEvidence | undefined | false {
  if (v == null) return undefined;
  if (!object(v) || !text(v.filePath, 500) || !Number.isSafeInteger(v.startLine) || Number(v.startLine) < 1)
    return false;
  return { filePath: v.filePath, startLine: Number(v.startLine) };
}

export function normalizeDiagramExploration(value: unknown): DiagramExploration | null {
  if (!object(value) || !['architecture', 'component', 'sequence', 'dataflow'].includes(String(value.kind)))
    return null;
  if (
    !Array.isArray(value.entities) ||
    !value.entities.length ||
    value.entities.length > 24 ||
    !Array.isArray(value.relationships) ||
    value.relationships.length > 48
  )
    return null;
  const ids = new Set<string>();
  const entities: DiagramExploration['entities'] = [];
  for (const e of value.entities) {
    if (
      !object(e) ||
      !id(e.id) ||
      ids.has(e.id) ||
      !text(e.label, 80) ||
      !text(e.summary, 500) ||
      !['changed', 'context'].includes(String(e.change))
    )
      return null;
    const source = evidence(e.evidence);
    if (source === false) return null;
    ids.add(e.id);
    entities.push({
      id: e.id,
      label: e.label,
      summary: e.summary,
      change: e.change as 'changed' | 'context',
      ...(source ? { evidence: source } : {}),
    });
  }
  const entityIds = new Set(ids);
  const relationships: DiagramExploration['relationships'] = [];
  for (const r of value.relationships) {
    if (
      !object(r) ||
      !id(r.id) ||
      ids.has(r.id) ||
      typeof r.from !== 'string' ||
      typeof r.to !== 'string' ||
      !entityIds.has(r.from) ||
      !entityIds.has(r.to) ||
      !text(r.label, 100) ||
      !text(r.summary, 500)
    )
      return null;
    const source = evidence(r.evidence);
    if (source === false) return null;
    ids.add(r.id);
    relationships.push({
      id: r.id,
      from: r.from,
      to: r.to,
      label: r.label,
      summary: r.summary,
      ...(source ? { evidence: source } : {}),
    });
  }
  return { kind: value.kind as DiagramExploration['kind'], entities, relationships };
}

/** Focus only the explicit, immediate relationships; never imply transitive execution. */
export function diagramFocus(exploration: DiagramExploration, selected: string | null): string[] {
  if (!selected) return [];
  const relationship = exploration.relationships.find((r) => r.id === selected);
  if (relationship) return [relationship.id, relationship.from, relationship.to];
  if (!exploration.entities.some((e) => e.id === selected)) return [];
  return [
    ...new Set([
      selected,
      ...exploration.relationships
        .filter((r) => r.from === selected || r.to === selected)
        .flatMap((r) => [r.id, r.from, r.to]),
    ]),
  ];
}
