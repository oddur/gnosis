import { createHighlighter } from 'shiki';

// Gallery-only source viewer. Tokenization stays off the UI thread.
const highlighter = createHighlighter({
  themes: ['github-light', 'github-dark'],
  langs: ['typescript'],
});
type Token = { content: string; light: string; dark: string };
const cache = new Map<string, Token[][]>();
self.onmessage = async (event: MessageEvent<{ id: number; source: string }>) => {
  const { id, source } = event.data;
  try {
    let tokens = cache.get(source);
    if (!tokens) {
      const h = await highlighter;
      const highlighted = h.codeToTokens(source, {
        lang: 'typescript',
        themes: { light: 'github-light', dark: 'github-dark' },
        defaultColor: false,
      }).tokens;
      tokens = highlighted.map((line) =>
        line.map((token) => ({
          content: token.content,
          light: token.htmlStyle?.['--shiki-light'] ?? '#24292e',
          dark: token.htmlStyle?.['--shiki-dark'] ?? '#e1e4e8',
        }))
      );
      const oldest = cache.keys().next().value;
      if (cache.size >= 8 && oldest !== undefined) cache.delete(oldest);
      cache.set(source, tokens);
    }
    self.postMessage({ id, tokens });
  } catch {
    self.postMessage({ id, tokens: null });
  }
};
