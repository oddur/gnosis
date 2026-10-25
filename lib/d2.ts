import type { D2, Diagram } from '@d2lang/d2';
import DOMPurify from 'dompurify';
import { resolveD2Icons } from './d2-icons';

export interface D2Frame {
  name: string;
  svg: string;
  notes: { subject: string; text: string }[];
}
export interface D2Render {
  frames: D2Frame[];
  milliseconds: number;
}
// Prototype: lazy, local WASM worker; bounded shared cache includes theme.
let engine: Promise<D2> | undefined;
let pending = Promise.resolve();
const cache = new Map<string, Promise<D2Render>>();
let salt = 0;
function getEngine() {
  return (engine ??= import('@d2lang/d2').then(({ D2 }) => new D2()));
}
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
      if (
        attr.localName === 'href' &&
        !attr.value.startsWith('#') &&
        !attr.value.startsWith('data:image/svg+xml;base64,')
      )
        el.removeAttributeNode(attr);
    }
  }
  root.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  return new XMLSerializer().serializeToString(root);
}
export function renderD2(source: string, dark: boolean): Promise<D2Render> {
  const key = JSON.stringify([source, dark]);
  const cached = cache.get(key);
  if (cached) return cached;
  const job = pending.then(async () => {
    if (source.length > 40000) throw new Error('This diagram is too large. Split it into smaller concepts.');
    // Keep AI-provided diagrams self-contained. Do not resolve external imports,
    // images, font URLs, or links through the WASM runtime or the renderer.
    if (/(?:https?:|file:|data:|javascript:|@import|(?:^|\s)@[^\s])/im.test(source)) {
      throw new Error('Use self-contained D2 and bundled gnosis: icons; external resources are disabled.');
    }
    const start = performance.now();
    const d2 = await getEngine();
    const palette = dark
      ? {
          N1: '#e3e7ef',
          N2: '#a2adbf',
          N3: '#77849a',
          N4: '#424b5c',
          N5: '#343b48',
          N6: '#242a34',
          N7: '#1d2129',
          B1: '#c5d7ff',
          B2: '#a6bfff',
          B3: '#7396d9',
          B4: '#424f6a',
          B5: '#273957',
          B6: '#242f43',
          AA2: '#e0bfff',
          AA4: '#66517b',
          AA5: '#3e304b',
          AB4: '#50726b',
          AB5: '#263f3a',
        }
      : {
          N1: '#242a35',
          N2: '#626b7b',
          N3: '#7b8698',
          N4: '#b8c2d2',
          N5: '#d5dbe5',
          N6: '#f0f2f6',
          N7: '#ffffff',
          B1: '#24469c',
          B2: '#284eaf',
          B3: '#6c8bce',
          B4: '#a6bfff',
          B5: '#d8e3fc',
          B6: '#eaf0ff',
          AA2: '#62448a',
          AA4: '#bda6da',
          AA5: '#ede4f7',
          AB4: '#86b5a7',
          AB5: '#e0f0e9',
        };
    const theme = Object.entries(palette)
      .map(([name, value]) => `${name}: "${value}"`)
      .join('; ');
    const prepared =
      resolveD2Icons(source, dark) +
      `\n**.style.font-size: 24\n(** -> **)[*].style.font-size: 20\nvars: { d2-config: { theme-overrides: { ${theme} }; layout-engine: tala } }\n`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const compiled = await Promise.race([
      d2.compile(prepared, { layout: 'tala' }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          engine = undefined;
          void d2.dispose();
          reject(new Error('Layout took too long. Simplify this diagram and try again.'));
        }, 20000);
      }),
    ]).finally(() => clearTimeout(timer));
    const boards: Diagram[] = [
      compiled.diagram,
      ...(compiled.diagram.steps ?? []),
      ...(compiled.diagram.scenarios ?? []),
    ].filter((board): board is Diagram => !!board && !board.isFolderOnly);
    if (boards.length > 12) throw new Error('Use at most 12 walkthrough frames.');
    const frames: D2Frame[] = [];
    for (const board of boards) {
      for (const edge of board.connections) edge.italic = false;
      const svg = await d2.render(board, {
        ...compiled.renderOptions,
        themeID: dark ? 201 : 0,
        pad: 24,
        noXMLTag: true,
        salt: `gnosis-${++salt}`,
      });
      frames.push({
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
  });
  pending = job.then(
    () => undefined,
    () => undefined
  );
  cache.set(key, job);
  const oldest = cache.keys().next().value;
  if (cache.size > 32 && oldest !== undefined) cache.delete(oldest);
  void job.catch(() => cache.delete(key));
  return job;
}
