import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codePalette, codePaletteCSS, MUTED_CONTRAST } from '../lib/code-palette';
import { contrastRatio } from '../lib/code-contrast';

void test('The code palette takes the keyword colour from a Zed theme and from TextMate rules', () => {
  const zed = codePalette({ bg: '#0d1117', fg: '#e6edf3', zed: { style: { syntax: { keyword: { color: '#ff7b72' }, string: '#a5d6ff' } } } });
  assert.deepEqual([zed.background, zed.foreground, zed.keyword], ['#0d1117', '#e6edf3', '#ff7b72']);
  // A rule for `keyword` itself, not one for a narrower scope listed first.
  assert.equal(
    codePalette({
      bg: '#000000',
      fg: '#ffffff',
      textmate: {
        settings: [
          { scope: ['keyword.operator'], settings: { foreground: '#111111' } },
          { scope: 'storage, keyword', settings: { foreground: '#222222' } },
        ],
      },
    }).keyword,
    '#222222'
  );
  // TextMate grammars call `function` and `class` storage types when no keyword rule exists.
  assert.equal(
    codePalette({ bg: '#000000', fg: '#ffffff', textmate: { settings: [{ scope: 'storage.type', settings: { foreground: '#333333' } }] } }).keyword,
    '#333333'
  );
  assert.equal(codePalette({ bg: '#000000', fg: '#ffffff' }).keyword, undefined);
});

void test('Muted text is quieter than the text and stays readable on low-contrast themes', () => {
  // GitHub Dark, GitHub Dimmed, One Dark Pro, Poimandres.
  for (const [bg, fg] of [
    ['#24292e', '#e1e4e8'],
    ['#22272e', '#adbac7'],
    ['#282c34', '#abb2bf'],
    ['#1b1e28', '#a6accd'],
  ]) {
    const { muted } = codePalette({ bg, fg });
    assert.ok(contrastRatio(muted, bg) >= MUTED_CONTRAST, `${muted} on ${bg}: ${contrastRatio(muted, bg)}`);
    assert.ok(contrastRatio(muted, bg) < contrastRatio(fg, bg), `${muted} is quieter than ${fg}`);
  }
});

void test('The palette applies to the bars of diffs in that theme alone', () => {
  assert.equal(
    codePaletteCSS('gnosis-aurora-x', { background: '#0d1117', foreground: '#e6edf3', muted: '#a2a7ad', keyword: '#ff7b72' }),
    '.changes-diff[data-code-theme="gnosis-aurora-x"] .diff-gap{--diff-code-bg:#0d1117;--diff-code-fg:#e6edf3;--diff-code-muted:#a2a7ad;--diff-keyword:#ff7b72}'
  );
});
