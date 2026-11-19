import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codePalette, codePaletteCSS, TEXT_CONTRAST } from '../lib/code-palette';
import { contrastRatio, diffSurfaces } from '../lib/code-contrast';

void test('The code palette takes the keyword colour from a Zed theme and from TextMate rules', () => {
  const zed = codePalette({ bg: '#0d1117', fg: '#e6edf3', zed: { style: { syntax: { keyword: { color: '#ff7b72' }, string: '#a5d6ff' } } } });
  assert.deepEqual([zed.background, zed.foreground], ['#0d1117', '#e6edf3']);
  assert.match(zed.keyword ?? '', /^#/);
  const keyword = (settings: { scope: string | string[]; settings: { foreground: string } }[]) =>
    codePalette({ bg: '#000000', fg: '#ffffff', textmate: { settings } }).keyword;
  // A rule for `keyword` itself, not one for a narrower scope listed first. Colours that read already stay as they are.
  assert.equal(
    keyword([
      { scope: ['keyword.operator'], settings: { foreground: '#ff0000' } },
      { scope: 'storage, keyword', settings: { foreground: '#ffd700' } },
    ]),
    '#ffd700'
  );
  // TextMate grammars call `function` and `class` storage types when no keyword rule exists.
  assert.equal(keyword([{ scope: 'storage.type', settings: { foreground: '#7fffd4' } }]), '#7fffd4');
  assert.equal(codePalette({ bg: '#000000', fg: '#ffffff' }).keyword, undefined);
});

// GitHub Dark, GitHub Dimmed, One Dark Pro, Vitesse Dark, Poimandres, with their keyword colours.
const THEMES = [
  ['#24292e', '#e1e4e8', '#fb9da7'],
  ['#22272e', '#adbac7', '#f79c96'],
  ['#282c34', '#abb2bf', '#c678dd'],
  ['#121212', '#dbd7ca', '#4d9375'],
  ['#1b1e28', '#a6accd', '#91b4d5'],
];

void test('The header stands apart from the code and from its added and deleted lines', () => {
  for (const [bg, fg] of THEMES) {
    const { header, line } = codePalette({ bg, fg });
    assert.ok(contrastRatio(header, bg) >= 1.35, `${header} on ${bg}: ${contrastRatio(header, bg)}`);
    const { addition, deletion } = diffSurfaces(bg);
    for (const surface of [addition, deletion]) assert.ok(contrastRatio(header, surface) >= 1.12, `${header} on ${surface}`);
    assert.ok(contrastRatio(line, bg) > 1 && contrastRatio(line, header) > contrastRatio(bg, header), `${line} is darker than the code`);
  }
});

void test('Text on the header reads: names, muted text and kind words', () => {
  for (const [bg, fg, keyword] of THEMES) {
    const palette = codePalette({ bg, fg, textmate: { settings: [{ scope: 'keyword', settings: { foreground: keyword } }] } });
    for (const color of [palette.muted, palette.keyword ?? '']) {
      const ratio = contrastRatio(color, palette.header);
      assert.ok(ratio >= TEXT_CONTRAST, `${color} on ${palette.header}: ${ratio}`);
    }
    assert.ok(contrastRatio(fg, palette.header) >= 4.5, `${fg} on ${palette.header}`);
    assert.ok(contrastRatio(palette.muted, palette.header) <= contrastRatio(fg, palette.header), 'muted is not louder than names');
  }
});

void test('The file header is a step above the hunk header, and its text reads', () => {
  for (const [bg, fg] of THEMES) {
    const palette = codePalette({ bg, fg });
    const step = contrastRatio(palette.file, palette.header);
    assert.ok(step >= 1.25, `${palette.file} over ${palette.header}: ${step}`);
    for (const color of [palette.fileText, palette.fileMuted, palette.fileAdded, palette.fileDeleted]) {
      const ratio = contrastRatio(color, palette.file);
      assert.ok(ratio >= TEXT_CONTRAST, `${color} on ${palette.file}: ${ratio}`);
    }
    // The status rules (tokens.css --code-added, --code-deleted, --code-modified, --code-renamed).
    for (const rule of ['#85cf99', '#ff9ba5', '#e9c46a', '#8fc4ff'])
      assert.ok(contrastRatio(rule, palette.file) >= 3, `${rule} on ${palette.file}`);
  }
});

void test('The palette applies to the bars and file headers of diffs in that theme alone', () => {
  const palette = {
    background: '#0d1117',
    foreground: '#e6edf3',
    header: '#272a35',
    line: '#010103',
    muted: '#a2a7ad',
    keyword: '#ff7b72',
    file: '#393f4c',
    fileText: '#ffffff',
    fileMuted: '#b0b2b7',
    fileAdded: '#9ad8ab',
    fileDeleted: '#ffb0b8',
  };
  assert.equal(
    codePaletteCSS('gnosis-aurora-x', palette),
    '[data-code-theme="gnosis-aurora-x"] :is(.diff-gap,.changes-file-header){--diff-code-bg:#0d1117;--diff-code-fg:#e6edf3;--diff-code-header:#272a35;--diff-code-line:#010103;--diff-code-muted:#a2a7ad;--diff-keyword:#ff7b72;--diff-file-bg:#393f4c;--diff-file-fg:#ffffff;--diff-file-muted:#b0b2b7;--diff-file-added:#9ad8ab;--diff-file-deleted:#ffb0b8}'
  );
});
