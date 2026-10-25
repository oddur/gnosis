import type { D2, Diagram } from '@d2lang/d2';
import DOMPurify from 'dompurify';
import { D2_ICON_NAMES, d2IconData } from './d2-icons';
import { prepareD2Source } from './d2-source';

export interface D2Frame {
  id: string;
  name: string;
  animated: boolean;
  svg: string;
  notes: { subject: string; text: string }[];
}
export interface D2Render {
  frames: D2Frame[];
  milliseconds: number;
}
// Local WASM worker, serialized jobs, and a bounded cache shared by all viewers.
let engine: Promise<D2> | undefined;
let pending = Promise.resolve();
const cache = new Map<string, Promise<D2Render>>();
const ready = new Map<string, D2Render>();
export function cachedD2(source: string, dark: boolean): D2Render | undefined {
  return ready.get(JSON.stringify([source, dark]));
}
let salt = 0;
function getEngine() {
  if (!engine) {
    engine = import('@d2lang/d2')
      .then(({ D2 }) => new D2())
      .catch((error: unknown) => {
        engine = undefined;
        throw error;
      });
  }
  return engine;
}
const iconURLs = new Set(D2_ICON_NAMES.flatMap((name) => [d2IconData(name, false), d2IconData(name, true)]));
function cleanSVG(svg: string) {
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject', 'a', 'script', 'animate', 'set'],
    ADD_TAGS: ['style'],
  });
  const doc = new DOMParser().parseFromString(clean, 'image/svg+xml');
  const root = doc.documentElement;
  // D2 icons are bundled data, never network requests from generated content.
  for (const el of root.querySelectorAll('[href], [*|href]')) {
    for (const attr of [...el.attributes]) {
      if (attr.localName === 'href' && !attr.value.startsWith('#') && !iconURLs.has(attr.value))
        el.removeAttributeNode(attr);
    }
  }
  root.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  return new XMLSerializer().serializeToString(root);
}
export function renderD2(source: string, dark: boolean): Promise<D2Render> {
  const key = JSON.stringify([source, dark]);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const job = pending.then(async () => {
    let client: D2 | undefined;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => {
      const start = performance.now();
      const d2 = await getEngine();
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the deadline can expire while the module loads
      if (expired) {
        void d2.dispose();
        throw new Error('Diagram rendering was cancelled.');
      }
      client = d2;
      const compiled = await d2.compile(prepareD2Source(source, dark), { layout: 'tala' });
      if (
        compiled.diagram.layers?.length ||
        [...(compiled.diagram.steps ?? []), ...(compiled.diagram.scenarios ?? [])].some(
          (board) => board && (board.steps?.length || board.scenarios?.length || board.layers?.length)
        )
      ) {
        throw new Error(
          'Use top-level steps or scenarios for this diagram. Nested boards and layers are not supported.'
        );
      }
      const boards: { id: string; board: Diagram }[] = [
        { id: 'overview', board: compiled.diagram },
        ...(compiled.diagram.steps ?? []).flatMap((board) => (board ? [{ id: `steps.${board.name}`, board }] : [])),
        ...(compiled.diagram.scenarios ?? []).flatMap((board) =>
          board ? [{ id: `scenarios.${board.name}`, board }] : []
        ),
      ].filter(({ board }) => !board.isFolderOnly);
      if (boards.length > 12) throw new Error('Use at most 12 walkthrough frames.');
      const frames: D2Frame[] = [];
      for (const { id, board } of boards) {
        for (const edge of board.connections) edge.italic = false;
        const svg = await d2.render(board, {
          ...compiled.renderOptions,
          // Playback is owned by the app, not source-configured SVG autoplay.
          animateInterval: 0,
          target: undefined,
          ascii: false,
          darkThemeID: undefined,
          sketch: false,
          themeID: dark ? 201 : 0,
          pad: 24,
          noXMLTag: true,
          salt: `gnosis-${++salt}`,
        });
        frames.push({
          id,
          animated: [...board.shapes, ...board.connections].some((item) => item.animated),
          name: board.name || 'Overview',
          svg: cleanSVG(svg),
          notes: [...board.shapes, ...board.connections]
            .filter((item) => item.tooltip)
            .map((item) => ({
              subject: ('label' in item && typeof item.label === 'string' ? item.label : null) || item.id,
              text: item.tooltip,
            })),
        });
      }
      return { frames, milliseconds: Math.round(performance.now() - start) };
    })();
    return Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          engine = undefined;
          if (client) void client.dispose();
          reject(
            new Error(
              'Diagram rendering took too long. Try again or regenerate this explanation with a simpler diagram.'
            )
          );
        }, 20000);
      }),
    ]).finally(() => clearTimeout(timer));
  });
  pending = job.then(
    () => undefined,
    () => undefined
  );
  cache.set(key, job);
  const oldest = cache.keys().next().value;
  if (cache.size > 24 && oldest !== undefined) {
    cache.delete(oldest);
    ready.delete(oldest);
  }
  void job.then(
    (rendered) => {
      if (cache.get(key) !== job) return;
      ready.set(key, rendered);
      // SVGs may embed fonts; also bound bytes, not just entry count.
      let bytes = [...ready.values()].reduce(
        (sum, item) => sum + item.frames.reduce((n, frame) => n + frame.svg.length * 2, 0),
        0
      );
      for (const oldest of cache.keys()) {
        if (bytes <= 12 * 1024 * 1024) break;
        const old = ready.get(oldest);
        if (!old) continue;
        bytes -= old.frames.reduce((n, frame) => n + frame.svg.length * 2, 0);
        ready.delete(oldest);
        cache.delete(oldest);
      }
    },
    () => undefined
  );
  void job.catch(() => {
    if (cache.get(key) === job) {
      cache.delete(key);
      ready.delete(key);
    }
  });
  return job;
}
