import { createHighlighter, type Highlighter, type ShikiTransformer } from 'shiki';
import { CODE_THEMES } from './constants';
import { contentHasDiffMarkers } from './diff-lines';
import type { ReviewGuide } from './types';

let highlighterInstance: Highlighter | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterInstance) {
    highlighterInstance = await createHighlighter({
      themes: CODE_THEMES.map((t) => t.id),
      langs: [
        'typescript',
        'javascript',
        'tsx',
        'jsx',
        'python',
        'go',
        'rust',
        'java',
        'kotlin',
        'csharp',
        'cpp',
        'c',
        'css',
        'scss',
        'html',
        'json',
        'yaml',
        'toml',
        'bash',
        'shell',
        'sql',
        'markdown',
        'diff',
        'swift',
        'ruby',
        'php',
      ],
    });
  }
  return highlighterInstance;
}

const SUPPORTED_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'kotlin',
  'csharp',
  'cpp',
  'c',
  'css',
  'scss',
  'html',
  'json',
  'yaml',
  'toml',
  'bash',
  'shell',
  'sql',
  'markdown',
  'swift',
  'ruby',
  'php',
]);

/**
 * Render a diff hunk using Shiki with a position-based diff transformer.
 *
 * Instead of appending text annotations (// [!code ++]) which break when the
 * code line contains multi-span comment syntax (e.g. C# XML doc comments),
 * we track the diff type for each line by position and apply classes directly
 * via a custom ShikiTransformer. This works for every language.
 */
export async function renderDiffHunk(
  content: string,
  language: string,
  theme = 'aurora-x',
  hunkHeader?: string
): Promise<string> {
  const highlighter = await getHighlighter();
  const lang = SUPPORTED_LANGUAGES.has(language) ? language : 'text';

  type DiffType = 'add' | 'remove' | 'context';
  const diffTypes: DiffType[] = [];
  const codeLines: string[] = [];

  const hasMarkers = contentHasDiffMarkers(content);

  // When markers are absent, infer diff type from hunk header
  let fallbackType: DiffType = 'context';
  if (!hasMarkers && hunkHeader) {
    const m = hunkHeader.match(/@@ -(\d+)(?:,(\d+))? \+/);
    if (m) {
      const oldStart = parseInt(m[1], 10);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- regex optional group can be undefined at runtime
      const oldCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;
      if (oldStart === 0 && oldCount === 0) fallbackType = 'add';
    }
  }

  for (const line of content.split('\n')) {
    if (line === '') continue;
    if (hasMarkers) {
      const prefix = line[0];
      diffTypes.push(prefix === '+' ? 'add' : prefix === '-' ? 'remove' : 'context');
      codeLines.push(line.slice(1));
    } else {
      diffTypes.push(fallbackType);
      codeLines.push(line);
    }
  }

  // Empty content: return minimal HTML to avoid Shiki producing a single empty line span
  if (codeLines.length === 0) {
    return '<pre class="shiki"><code></code></pre>';
  }

  const hasDiff = diffTypes.some((t) => t !== 'context');

  const diffTransformer: ShikiTransformer = {
    name: 'pr-review-diff',
    pre(node) {
      if (hasDiff) this.addClassToHast(node, 'has-diff');
    },
    line(node, lineNumber) {
      // lineNumber is 1-indexed
      const type = diffTypes[lineNumber - 1];
      if (type === 'add') this.addClassToHast(node, ['diff', 'add']);
      else if (type === 'remove') this.addClassToHast(node, ['diff', 'remove']);
    },
  };

  return highlighter.codeToHtml(codeLines.join('\n'), {
    lang,
    theme,
    // Aurora X's muted comment ink falls below AA on diff backgrounds.
    // Apply at tokenization so unified/split views and saved exports agree.
    colorReplacements: theme === 'aurora-x' ? { '#546e7a': '#91a7b2' } : undefined,
    transformers: [diffTransformer],
  });
}

export function inferLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    cs: 'csharp',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    c: 'c',
    h: 'c',
    css: 'css',
    scss: 'scss',
    html: 'html',
    htm: 'html',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    sh: 'bash',
    bash: 'bash',
    sql: 'sql',
    md: 'markdown',
    swift: 'swift',
    rb: 'ruby',
    php: 'php',
  };
  return map[ext ?? ''] ?? 'text';
}

export async function reRenderAllHunks(review: ReviewGuide, theme: string): Promise<void> {
  for (const slide of review.slides) {
    for (const hunk of slide.diffHunks) {
      try {
        hunk.renderedHtml = await renderDiffHunk(hunk.content, hunk.language, theme, hunk.hunkHeader);
      } catch (err) {
        console.warn(`[highlight] Failed to re-render hunk for ${hunk.filePath}:`, err);
      }
    }
  }
}
