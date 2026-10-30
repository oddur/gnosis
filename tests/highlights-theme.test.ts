import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeToTokens } from '@pierre/highlights';
import { themes } from '@pierre/highlights/themes/loader';
import { CODE_THEMES } from '../lib/constants';
import { contrastRatio, diffSurfaces } from '../lib/code-contrast';
import { readableHighlightsTheme } from '../lib/highlights-theme';

for (const { id } of CODE_THEMES) {
  void test(`${id}: Highlights keeps syntax legible on changed lines`, async () => {
    const original = (await themes[id]()).default;
    const theme = readableHighlightsTheme(original, `gnosis-${id}`);
    const background = theme.style['editor.background'];
    assert.equal(background, original.style['editor.background']);
    assert.ok(background);
    const syntax = Object.values(theme.style.syntax ?? {});
    assert.ok(syntax.length > 5);
    for (const color of [
      theme.style['editor.foreground'],
      theme.style['gitDecoration.addedResourceForeground'],
      theme.style['gitDecoration.deletedResourceForeground'],
      ...syntax.map((t) => (typeof t === 'string' ? t : t.color)),
    ]) {
      if (!color) continue;
      assert.ok(typeof color === 'string');
      assert.match(color, /^#[\da-f]{6}$/i);
      for (const surface of Object.values(diffSurfaces(background))) {
        assert.ok(contrastRatio(color, surface) >= 4.8, `${color} on ${surface}`);
      }
    }
    for (const [key, settings] of Object.entries(original.style.syntax ?? {})) {
      const adjusted = theme.style.syntax?.[key];
      assert.ok(adjusted && typeof adjusted !== 'string');
      if (typeof settings !== 'string') {
        assert.equal(adjusted.font_style, settings.font_style);
        assert.equal(adjusted.font_weight, settings.font_weight);
      }
    }
  });
}

void test('Highlights preserves Unicode, strings, comments, and embedded code', async () => {
  const theme = readableHighlightsTheme((await themes['github-dark']()).default, 'gnosis-test');
  const samples = {
    tsx: '// café 🚀\nconst label = `Hello ${name}`;\nexport const View = () => <span>{label}</span>;',
    rust: '// café 🚀\nfn greet(name: &str) -> String { format!("Hello {name}") }',
    python: '# café 🚀\ndef greet(name):\n    return f"Hello {name}"',
    cpp: '// café 🚀\nstd::string greet() { return R"(hello "world")"; }',
    html: '<!-- café 🚀 -->\n<div class="message">Hello <strong>world</strong></div>',
    sql: "-- café 🚀\nSELECT name FROM users WHERE state = 'active';",
  };
  for (const lang of Object.keys(samples) as (keyof typeof samples)[]) {
    const source = samples[lang];
    const result = codeToTokens(source, { lang, theme });
    assert.equal(result.tokens.map((line) => line.map((token) => token.content).join('')).join('\n'), source, lang);
    assert.ok(new Set(result.tokens.flat().map((token) => token.color)).size >= 3, `${lang} must have syntax colors`);
    assert.notEqual(result.tokens[0][0].color, result.fg, `${lang} comment should be distinct`);
  }
});

void test('Pierre preserves unsupported languages as plain text with Highlights', async () => {
  const { getSharedHighlighter, disposeHighlighter, registerCustomTheme } = await import('@pierre/diffs');
  registerCustomTheme(
    'gnosis-fallback-test',
    async () => readableHighlightsTheme((await themes['github-dark']()).default, 'gnosis-fallback-test'),
    'zed'
  );
  const highlighter = await getSharedHighlighter({
    preferredHighlighter: 'highlights',
    themes: ['gnosis-fallback-test'],
    langs: ['cobol'],
  });
  try {
    const source = '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. HELLO.';
    const result = highlighter.codeToTokens(source, { lang: 'cobol', theme: 'gnosis-fallback-test' });
    assert.equal(result.tokens.map((line) => line.map((token) => token.content).join('')).join('\n'), source);
    assert.equal(new Set(result.tokens.flat().map((token) => token.color)).size, 1);
  } finally {
    await disposeHighlighter();
  }
});
