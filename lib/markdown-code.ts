import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';
import type { Element, Root, RootContent } from 'hast';
let highlighter: Promise<Highlighter> | undefined;
const languages = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'css',
  'html',
  'json',
  'yaml',
  'toml',
  'bash',
  'sql',
  'markdown',
  'diff',
] as const;
const languageSet = new Set<string>(languages);
const aliases: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  sh: 'bash',
  shell: 'bash',
  yml: 'yaml',
  py: 'python',
  rs: 'rust',
};
export const codeLanguage = (pre: Element) => {
  const code = pre.children.find((n) => n.type === 'element' && n.tagName === 'code');
  if (code?.type !== 'element') return '';
  return (
    (Array.isArray(code.properties.className) ? code.properties.className.map(String) : [])
      .find((name) => name.startsWith('language-'))
      ?.slice(9) ?? ''
  );
};
export const isDiagramCode = (pre: Element) => ['mermaid', 'd2'].includes(codeLanguage(pre));
/** Syntax work happens in the same backend worker as document comparison. */
export async function highlightMarkdownCode(tree: Root) {
  const jobs: Element[] = [];
  const visit = (node: Root | RootContent) => {
    if (node.type !== 'root' && node.type !== 'element') return;
    if (node.type === 'element' && node.tagName === 'pre' && !isDiagramCode(node)) jobs.push(node);
    else node.children.forEach(visit);
  };
  visit(tree);
  if (!jobs.length) return;
  highlighter ??= createHighlighter({ themes: ['github-light', 'github-dark'], langs: [...languages] });
  const h = await highlighter;
  for (const pre of jobs) {
    const code = pre.children.find((n) => n.type === 'element' && n.tagName === 'code');
    if (code?.type !== 'element') continue;
    const language = aliases[codeLanguage(pre)] ?? codeLanguage(pre);
    const lines: Element[] = code.children.every((n) => n.type === 'element' && n.properties['data-code-line'])
      ? (code.children as Element[])
      : code.children
          .filter((n) => n.type === 'text')
          .map((n) => n.value)
          .join('')
          .replace(/\n$/, '')
          .split('\n')
          .map((value) => ({
            type: 'element',
            tagName: 'span',
            properties: { 'data-code-line': true },
            children: [{ type: 'text', value }],
          }));
    const source = lines
      .map((line) =>
        line.children
          .filter((n) => n.type === 'text')
          .map((n) => n.value)
          .join('')
      )
      .join('\n');
    if (source.length > 50_000) continue;
    const result = h.codeToTokens(source, {
      lang: languageSet.has(language) ? (language as BundledLanguage) : 'text',
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    });
    lines.forEach((line, index) => {
      line.children = (result.tokens[index] ?? []).map((token) => ({
        type: 'element',
        tagName: 'span',
        properties: {
          style: Object.entries(token.htmlStyle ?? {})
            .map(([key, value]) => `${key}:${value}`)
            .join(';'),
        },
        children: [{ type: 'text', value: token.content }],
      }));
    });
    code.children = lines;
    pre.properties.className = ['markdown-highlighted-code'];
  }
}
