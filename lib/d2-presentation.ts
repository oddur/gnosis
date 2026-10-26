import type { D2DiagramSpec } from './types';
import type { D2Frame } from './d2';
import { diagramFrameCaption } from './diagram-spec';

export interface DiagramEntity {
  id: string;
  label: string;
  src?: string;
  dst?: string;
  emphasized: boolean;
}
export interface DiagramView {
  key: string;
  frame: D2Frame;
  title: string;
  description: string;
  change?: string;
  evidence?: { filePath: string; startLine: number };
  focus: string[];
  differences: { label: string; before: string; after: string }[];
}

/** Presentation metadata never causes an additional layout or compiler request. */
export function diagramViews(spec: D2DiagramSpec, frames: D2Frame[]): DiagramView[] {
  const guided = spec.steps?.some((step) => step.focus?.length);
  const entries = guided
    ? (spec.steps ?? []).flatMap((step, i) => {
        const frame = frames.find((item) => item.id === (step.board || 'overview'));
        return frame ? [{ frame, caption: step, index: i }] : [];
      })
    : frames.map((frame, i) => ({ frame, caption: diagramFrameCaption(spec, frame.id, i), index: i }));
  if (guided && !spec.kind && frames[0] && entries[0]?.caption?.focus?.length) {
    entries.unshift({ frame: frames[0], caption: { title: 'Overview', description: spec.caption ?? '' }, index: -1 });
  }
  // Bad optional references must not hide an otherwise usable saved diagram.
  if (!entries.length && frames[0]) entries.push({ frame: frames[0], caption: undefined, index: 0 });
  return entries.map(({ frame, caption, index }, i) => {
    const previous = i > 0 ? entries[i - 1].frame : undefined;
    const differences: DiagramView['differences'] = [];
    if (previous && previous.id !== frame.id) {
      const old = new Map(previous.entities.map((entity) => [entity.id, entity]));
      for (const entity of frame.entities) {
        const before = old.get(entity.id);
        if (!before || before.label !== entity.label) {
          differences.push({
            label: entity.id,
            before: before?.label || 'Not present',
            after: entity.label || entity.id,
          });
        }
        old.delete(entity.id);
      }
      for (const entity of old.values())
        differences.push({ label: entity.id, before: entity.label || entity.id, after: 'Removed' });
    }
    return {
      key: `${frame.id}:${index}`,
      frame,
      title: caption?.title || (i === 0 ? 'Overview' : frame.name.replace(/_/g, ' ')),
      description: caption?.description || spec.caption || '',
      change: caption?.change,
      evidence: caption?.evidence,
      focus: caption?.focus ?? frame.entities.filter((entity) => entity.emphasized).map((entity) => entity.id),
      differences,
    };
  });
}

/** Tag only groups that match compiler entities, never model-supplied selectors. */
export function tagDiagramEntities(root: Element, entities: DiagramEntity[]) {
  const known = new Set(entities.map((entity) => entity.id));
  for (const group of root.querySelectorAll('g[class]')) {
    for (const token of group.classList) {
      try {
        // D2 encodes HTML-escaped identifiers as base64 class names.
        const decoded = new TextDecoder()
          .decode(Uint8Array.from(atob(token), (c) => c.charCodeAt(0)))
          .replace(/&gt;/g, '>')
          .replace(/&lt;/g, '<')
          .replace(/&#34;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, '&');
        if (known.has(decoded)) group.setAttribute('data-d2-entity', decoded);
      } catch {
        /* Ordinary SVG classes are not entity identifiers. */
      }
    }
  }
}

/** Spotlight the existing SVG without changing positions, bounds, or zoom. */
export function focusDiagram(svg: string, entities: DiagramEntity[], requested: string[]) {
  const active = new Set(requested.filter((id) => entities.some((entity) => entity.id === id)));
  if (!active.size) return svg;
  for (const entity of entities) {
    if (active.has(entity.id)) {
      if (entity.src) active.add(entity.src);
      if (entity.dst) active.add(entity.dst);
    }
  }
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  for (const group of doc.querySelectorAll('[data-d2-entity]')) {
    const id = group.getAttribute('data-d2-entity') ?? '';
    const parent = [...active].some((child) => child.startsWith(`${id}.`));
    group.setAttribute('data-d2-focus', active.has(id) ? 'active' : parent ? 'boundary' : 'context');
  }
  return new XMLSerializer().serializeToString(doc.documentElement);
}
