import { FileDiff, getSharedHighlighter, parseDiffFromFile, type HighlighterTypes } from '@pierre/diffs';
import { isSupportedLanguage } from '@pierre/highlights';
import '../../lib/diff-highlighter';

export interface HighlightSample {
  name: string;
  lang: string;
  source: string;
  added?: boolean;
}
export interface HighlightMeasurement {
  name: string;
  bytes: number;
  supported: boolean;
  tokenMs: number[];
  tokenCount: number;
  distinctColors: number;
  textPreserved: boolean;
  renderMs: number[];
  paintedMs: number[];
  maxBlockMs: number;
  renderedLines: number;
  renderedColors: number;
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function benchmark(backend: HighlighterTypes, samples: HighlightSample[], iterations: number) {
  const label = document.querySelector('#label');
  const container = document.querySelector('#diff');
  if (!label || !container) throw new Error('Missing benchmark container');
  const theme = 'gnosis-github-dark';
  const start = performance.now();
  const highlighter = await getSharedHighlighter({
    preferredHighlighter: backend,
    themes: [theme],
    langs: samples.map((s) => s.lang),
  });
  const setupMs = performance.now() - start;
  const results: HighlightMeasurement[] = [];
  for (const sample of samples) {
    label.textContent = `${backend} · ${sample.name}`;
    const tokenMs: number[] = [],
      renderMs: number[] = [],
      paintedMs: number[] = [];
    let tokenCount = 0,
      distinctColors = 0,
      textPreserved = false,
      renderedLines = 0,
      renderedColors = 0,
      maxBlockMs = 0;
    let lastTick = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxBlockMs = Math.max(maxBlockMs, now - lastTick - 10);
      lastTick = now;
    }, 10);
    try {
      for (let i = -1; i < iterations; i++) {
        await tick();
        const started = performance.now();
        const result = highlighter.codeToTokens(sample.source, { lang: sample.lang, theme });
        const elapsed = performance.now() - started;
        if (i >= 0) tokenMs.push(elapsed);
        tokenCount = result.tokens.reduce((n, line) => n + line.length, 0);
        distinctColors = new Set(
          result.tokens
            .flat()
            .map((t) => t.color)
            .filter(Boolean)
        ).size;
        if (distinctColors < 2) throw new Error(`No syntax colors for ${sample.name}`);
        textPreserved = result.tokens.map((line) => line.map((t) => t.content).join('')).join('\n') === sample.source;
        if (!textPreserved) throw new Error(`Tokenization changed text for ${sample.name}`);
      }
      // Three whitespace edits retain valid syntax in every input language.
      const oldFile = { name: sample.name, contents: sample.source };
      const changed = sample.source.split('\n');
      for (const fraction of [0.2, 0.5, 0.8]) {
        const index = Math.floor(changed.length * fraction);
        changed[index] += ' ';
      }
      const newFile = { name: sample.name, contents: changed.join('\n') };
      for (let i = -1; i < iterations; i++) {
        await tick();
        const host = document.createElement('diffs-container');
        container.replaceChildren(host);
        const started = performance.now();
        const diff = parseDiffFromFile(sample.added ? null : oldFile, newFile, { context: 3 });
        const renderer = new FileDiff({
          theme,
          themeType: 'dark',
          preferredHighlighter: backend,
          disableFileHeader: true,
          diffStyle: 'split',
          collapsedContextThreshold: 0,
          hunkSeparators: 'line-info',
          lineDiffType: 'word-alt',
          disableErrorHandling: true,
        });
        try {
          renderer.render({ fileDiff: diff, fileContainer: host });
          const elapsed = performance.now() - started;
          await frame();
          await frame();
          if (i >= 0) {
            renderMs.push(elapsed);
            paintedMs.push(performance.now() - started);
          }
          renderedLines = host.shadowRoot?.querySelectorAll('[data-code] [data-line]').length ?? 0;
          renderedColors = new Set(
            Array.from(host.shadowRoot?.querySelectorAll('[data-code] span[style]') ?? []).map(
              (node) => getComputedStyle(node).color
            )
          ).size;
          if (renderedColors < 2) throw new Error(`Rendered diff has no syntax colors: ${sample.name}`);
          if (!renderedLines) throw new Error('Benchmark rendered no diff lines');
        } finally {
          renderer.cleanUp();
        }
      }
      await tick();
      results.push({
        name: sample.name,
        bytes: new TextEncoder().encode(sample.source).length,
        supported: isSupportedLanguage(sample.lang),
        tokenMs,
        tokenCount,
        distinctColors,
        textPreserved,
        renderMs,
        paintedMs,
        maxBlockMs,
        renderedLines,
        renderedColors,
      });
    } finally {
      clearInterval(timer);
    }
  }
  // Keep a representative diff visible for a screenshot after timing is complete.
  const preview = `// Retry only failed requests. Preserve the caller's order.
interface Request { id: string; attempts: number }

export async function retryBatch(requests: Request[]) {
  const limit = 3;
  const pending = requests.filter(request => request.attempts < limit);
  const results = await Promise.all(pending.map(async request => {
    const response = await fetch(\`/api/items/\${request.id}\`);
    if (!response.ok) throw new Error("Request failed");
    return response.json();
  }));
  return results;
}

export const Status = ({ count }: { count: number }) => (
  <span aria-live="polite">{count} requests complete</span>
);`;
  label.textContent = `${backend} · Syntax comparison · GitHub Dark`;
  const host = document.createElement('diffs-container');
  container.replaceChildren(host);
  new FileDiff({
    theme,
    themeType: 'dark',
    preferredHighlighter: backend,
    diffStyle: 'split',
    expandUnchanged: true,
  }).render({
    fileContainer: host,
    fileDiff: parseDiffFromFile(
      { name: 'batch.tsx', contents: preview },
      {
        name: 'batch.tsx',
        contents: preview
          .replace('const limit = 3', 'const limit = 5')
          .replace('return response.json();', 'return { id: request.id, data: await response.json() };'),
      }
    ),
  });
  await frame();
  await frame();
  return { backend: highlighter.name, setupMs, results };
}

declare global {
  interface Window {
    benchmarkHighlights: typeof benchmark;
  }
}
window.benchmarkHighlights = benchmark;
