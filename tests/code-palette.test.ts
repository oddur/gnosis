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
    for (const color of [palette.muted, palette.keyword ?? '', palette.headerAdded, palette.headerDeleted]) {
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
    assert.ok(contrastRatio(palette.fileControl, palette.file) >= 3, `${palette.fileControl} outlines on ${palette.file}`);
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
    headerAdded: '#85cf99',
    headerDeleted: '#ff9ba5',
    file: '#393f4c',
    fileText: '#ffffff',
    fileMuted: '#b0b2b7',
    fileControl: '#8a8f99',
    fileAdded: '#9ad8ab',
    fileDeleted: '#ffb0b8',
  };
  assert.equal(
    codePaletteCSS('gnosis-aurora-x', palette),
    '[data-code-theme="gnosis-aurora-x"] :is(.diff-gap,.diff-move-lead,.changes-file-header,.diff-outline,[data-markdown=code-block]){--diff-code-bg:#0d1117;--diff-code-fg:#e6edf3;--diff-code-header:#272a35;--diff-code-line:#010103;--diff-code-muted:#a2a7ad;--diff-keyword:#ff7b72;--diff-code-added:#85cf99;--diff-code-deleted:#ff9ba5;--diff-file-bg:#393f4c;--diff-file-fg:#ffffff;--diff-file-muted:#b0b2b7;--diff-file-control:#8a8f99;--diff-file-added:#9ad8ab;--diff-file-deleted:#ffb0b8}'
  );
});

void test('"You are here" shows on every theme and surface, and the line under it stays readable', async () => {
  const { HERE_BAND, HERE_SETTLED, HERE_PEAK, HERE_BAR, HERE_SECTION_SETTLED, HERE_SECTION_PEAK, toOklab } = await import('../lib/code-palette');
  const { HERE_CSS } = await import('../lib/diff-here');
  const { mixColor } = await import('../lib/code-contrast');
  const distance = (a: string, b: string) => {
    const x = toOklab(a),
      y = toOklab(b);
    return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
  };
  // All ten code themes: background and default text.
  const themes = [
    ...THEMES.map(([bg, fg]) => [bg, fg]),
    ['#282a36', '#f8f8f2'],
    ['#2e3440', '#d8dee9'],
    ['#1a1b26', '#a9b1d6'],
    ['#1e1e2e', '#cdd6f4'],
    ['#07090f', '#bbc3cf'],
  ];
  for (const [bg, fg] of themes) {
    const surfaces = diffSurfaces(bg);
    for (const [name, surface] of Object.entries(surfaces)) {
      const settled = mixColor(surface, HERE_BAND, HERE_SETTLED);
      const peak = mixColor(surface, HERE_BAND, HERE_PEAK);
      // Visible: well past a just-noticeable difference (about 0.02 in OKLab), on green and red lines too.
      assert.ok(distance(settled, surface) >= 0.045, `${bg} ${name}: the settled band shows (${distance(settled, surface)})`);
      assert.ok(distance(peak, surface) > distance(settled, surface), `${bg} ${name}: the bloom is stronger than the band`);
      // Readable: the settled band keeps at least 80% of the text's contrast.
      const kept = contrastRatio(fg, settled) / contrastRatio(fg, surface);
      assert.ok(kept >= 0.8, `${bg} ${name}: text keeps ${kept.toFixed(2)} of its contrast`);
      // The bar on the gutter's edge reads as a mark: 3:1 against the band it edges.
      assert.ok(contrastRatio(HERE_BAR, settled) >= 3, `${bg} ${name}: the bar shows on the band`);
      // The rest of a marked section: softer than the signature, still visible, and its text keeps more of its contrast,
      // at the section's bloom as well as settled.
      const body = mixColor(surface, HERE_BAND, HERE_SECTION_SETTLED);
      const bodyPeak = mixColor(surface, HERE_BAND, HERE_SECTION_PEAK);
      assert.ok(distance(body, surface) >= 0.025 && distance(body, surface) < distance(settled, surface), `${bg} ${name}: the section's band shows, softer (${distance(body, surface)})`);
      for (const band of [body, bodyPeak]) {
        const keptBody = contrastRatio(fg, band) / contrastRatio(fg, surface);
        assert.ok(keptBody >= 0.85, `${bg} ${name}: the section's text keeps ${keptBody.toFixed(2)} of its contrast`);
      }
      assert.ok(contrastRatio(HERE_BAR, body) >= 3, `${bg} ${name}: the bar shows down the section`);
    }
  }
  // The CSS draws the same colours.
  const rgb = [1, 3, 5].map((i) => parseInt(HERE_BAND.slice(i, i + 2), 16)).join(' ');
  assert.ok(HERE_CSS.includes(`rgb(${rgb} / ${Math.round(HERE_SETTLED * 100)}%)`), 'the settled band in HERE_CSS');
  assert.ok(HERE_CSS.includes(`rgb(${rgb} / ${Math.round(HERE_PEAK * 100)}%)`), 'the bloom in HERE_CSS');
  assert.ok(HERE_CSS.includes(`rgb(${rgb} / ${Math.round(HERE_SECTION_SETTLED * 100)}%)`), 'the section band in HERE_CSS');
  assert.ok(HERE_CSS.includes(`rgb(${rgb} / ${Math.round(HERE_SECTION_PEAK * 100)}%)`), 'the section bloom in HERE_CSS');
  // The steady mark on lines a resolver wrote (#445 item 10) is the section's settled band, held still: its contrast is
  // checked above. It never animates.
  const { WRITTEN_CSS } = await import('../lib/diff-here');
  assert.ok(WRITTEN_CSS.includes(`rgb(${rgb} / ${Math.round(HERE_SECTION_SETTLED * 100)}%)`), 'the steady band in WRITTEN_CSS');
  assert.ok(!/animation|@keyframes|transition/.test(WRITTEN_CSS), 'the steady band never moves');
  // The card's swatch is drawn from the same colours, never a copy of them (#493 review).
  const { WRITTEN_SWATCH } = await import('../lib/diff-here');
  assert.ok(WRITTEN_SWATCH.includes(`rgb(${rgb} / ${Math.round(HERE_SECTION_SETTLED * 100)}%)`), 'the swatch uses the band');
  const css = (await import('node:fs')).readFileSync(new URL('../src/globals.css', import.meta.url), 'utf8');
  const swatch = css.match(/\.conflict-written-swatch \{[^}]*\}/)?.[0] ?? '';
  assert.ok(swatch && !/rgb|#[0-9a-f]{3}/i.test(swatch), `the swatch CSS has no colour of its own: ${swatch}`);
});
