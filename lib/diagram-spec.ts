import type { D2DiagramSpec } from './types';

const text = (value: unknown, limit: number) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');

/** Optional model output must never make the surrounding review unreadable. */
export function normalizeD2Diagram(value: unknown): D2DiagramSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.source !== 'string' || input.source.length > 40000) return null;
  const source = input.source
    .trim()
    .replace(/^```(?:d2)?\s*\n([\s\S]*?)\n```$/, '$1')
    .trim();
  if (!source) return null;
  const steps: NonNullable<D2DiagramSpec['steps']> = [];
  if (Array.isArray(input.steps)) {
    for (const raw of input.steps.slice(0, 12)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        // Keep positional metadata aligned for older saved diagrams.
        steps.push({ title: '', description: '' });
        continue;
      }
      const step = raw as Record<string, unknown>;
      const board = text(step.board, 160);
      const evidence =
        step.evidence && typeof step.evidence === 'object' ? (step.evidence as Record<string, unknown>) : undefined;
      steps.push({
        ...(board ? { board } : {}),
        ...(evidence &&
        text(evidence.filePath, 500) &&
        Number.isSafeInteger(evidence.startLine) &&
        Number(evidence.startLine) > 0
          ? { evidence: { filePath: text(evidence.filePath, 500), startLine: Number(evidence.startLine) } }
          : {}),
        title: text(step.title, 160),
        description: text(step.description, 1400),
        ...(Array.isArray(step.focus)
          ? { focus: [...new Set(step.focus.map((id) => text(id, 240)).filter(Boolean))].slice(0, 24) }
          : {}),
        ...(text(step.change, 600) ? { change: text(step.change, 600) } : {}),
      });
    }
  }
  const caption = text(input.caption, 1400);
  const kind =
    input.kind === 'map' || input.kind === 'walkthrough' || input.kind === 'comparison' ? input.kind : undefined;
  return { source, ...(kind ? { kind } : {}), ...(caption ? { caption } : {}), ...(steps.length ? { steps } : {}) };
}

export function diagramFrameCaption(diagram: D2DiagramSpec, board: string, index: number) {
  // Named captions survive source board reordering. Positional captions remain
  // supported for reviews saved by the original prototype.
  return diagram.steps?.some((step) => step.board)
    ? diagram.steps.find((step) => step.board === board)
    : diagram.steps?.[index];
}
