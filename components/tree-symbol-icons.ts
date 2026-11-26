import { createFileTreeIconResolver, getBuiltInSpriteSheet, type FileTreeIconConfig } from '@pierre/trees';
import { CODE_END, FILE_MARK, rowCodes, type TreeRowIcon, type TreeRowTint } from '../lib/tree-symbol-paths';
import { DIFF_STAT_COLORS } from './DiffStats';

/**
 * Icons and looks for the Changes tree's symbol rows (lib/tree-symbol-paths.ts), inside Pierre's shadow DOM:
 * - a symbol row with no children gets its kind icon through Pierre's own icon rules, by the invisible code in its
 *   name, from a sprite of lucide icons (ISC) tinted by the symbol's change;
 * - a row with children is a folder to Pierre, whose icon slot holds only its chevron: CSS adds the kind icon, or for
 *   a file of symbols its file-type icon, after the chevron;
 * - context rows and notes are muted, and the row the reader is in is lit.
 */

/** Lucide (ISC) icon bodies, on a 24 px grid. */
const LUCIDE: Record<TreeRowIcon, string> = {
  function: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3"/><path d="M9 11.2h5.7"/>',
  method: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  class: '<path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"/><path d="m7 16.5-4.74-2.85"/><path d="m7 16.5 5-3"/><path d="M7 16.5v5.17"/><path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"/><path d="m17 16.5-5-3"/><path d="m17 16.5 4.74-2.85"/><path d="M17 16.5v5.17"/><path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"/><path d="M12 8 7.26 5.15"/><path d="m12 8 4.74-2.85"/><path d="M12 13.5V8"/>',
  interface: '<path d="M15.536 11.293a1 1 0 0 0 0 1.414l2.376 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z"/><path d="M2.297 11.293a1 1 0 0 0 0 1.414l2.377 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414L6.088 8.916a1 1 0 0 0-1.414 0z"/><path d="M8.916 17.912a1 1 0 0 0 0 1.415l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.415l-2.377-2.376a1 1 0 0 0-1.414 0z"/><path d="M8.916 4.674a1 1 0 0 0 0 1.414l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z"/>',
  type: '<path d="M12 4v16"/><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 20h6"/>',
  enum: '<path d="M11 5h10"/><path d="M11 12h10"/><path d="M11 19h10"/><path d="M4 4h1v5"/><path d="M4 9h2"/><path d="M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02"/>',
  variable: '<path d="M8 21s-4-3-4-9 4-9 4-9"/><path d="M16 3s4 3 4 9-4 9-4 9"/><line x1="15" x2="9" y1="9" y2="15"/><line x1="9" x2="15" y1="9" y2="15"/>',
  module: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/>',
  top: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
  imports: '<path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M8 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4"/>',
  loading: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  note: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
};
const TINT_COLORS: Record<TreeRowTint, string> = {
  added: DIFF_STAT_COLORS.added,
  modified: DIFF_STAT_COLORS.modified,
  removed: DIFF_STAT_COLORS.removed,
  context: 'var(--muted-foreground)',
  muted: 'var(--muted-foreground)',
};
const STROKE = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const symbolId = (icon: TreeRowIcon, tint: TreeRowTint) => `gnosis-tree-symbol-${icon}-${tint}`;

/** A string for a CSS attribute selector: the invisible marks escaped, so the rule reads the same in any editor. */
const cssString = (value: string) => `"${value.replace(/[^\w./ -]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `)}"`;
/** Both spellings of a row's path: Pierre gives a folder's with or without its slash. */
const endsWith = (suffix: string, folder: boolean) =>
  folder ? `[data-item-type="folder"]:is([data-item-path$=${cssString(`${suffix}/`)}], [data-item-path$=${cssString(suffix)}])` : `[data-item-type="file"][data-item-path$=${cssString(suffix)}]`;
const maskOf = (body: string, viewBox: string, attributes = '') =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" ${attributes}>${body}</svg>`)}")`;
const afterIcon = (mask: string, color: string) =>
  `content:"";width:16px;height:16px;flex:none;background:${color};mask:${mask} center / 14px 14px no-repeat;`;

/** The extensions of the languages with symbol rows (lib/tree-symbols.ts), for their files' icons. */
const EXTENSIONS = ['ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'py', 'pyi', 'go', 'rs', 'java', 'cs'];

let built: { icons: FileTreeIconConfig; css: string } | undefined;
/** The tree's icon rules and CSS, made once. */
export function treeSymbolLook(): { icons: FileTreeIconConfig; css: string } {
  if (built) return built;
  const codes = rowCodes();
  const sprite = codes
    .map(({ icon, tint }) => `<symbol id="${symbolId(icon, tint)}" viewBox="0 0 24 24"><g ${STROKE} style="color:${TINT_COLORS[tint]}">${LUCIDE[icon]}</g></symbol>`)
    .join('');
  const icons: FileTreeIconConfig = {
    set: 'complete',
    colored: true,
    spriteSheet: `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${sprite}</svg>`,
    byFileNameContains: Object.fromEntries(codes.map(({ icon, tint, code }) => [code, { name: symbolId(icon, tint), viewBox: '0 0 24 24' }])),
  };
  // A folder row of symbols, or of a file, shows its chevron and then its own icon.
  const rules: string[] = [];
  for (const { icon, tint, code } of codes) {
    rules.push(`${endsWith(code, true)} > [data-item-section="icon"] { width:auto; gap:2px; }`);
    rules.push(`${endsWith(code, true)} > [data-item-section="icon"]::after { ${afterIcon(maskOf(`<g ${STROKE.replace('currentColor', 'black')}>${LUCIDE[icon]}</g>`, '0 0 24 24'), TINT_COLORS[tint])} }`);
    if (tint === 'context' || tint === 'muted')
      rules.push(`:is(${endsWith(code, true)}, ${endsWith(code, false)}) > [data-item-section="content"] { color:var(--muted-foreground); }`);
  }
  // A file of symbols keeps its file-type icon, from Pierre's own set.
  const resolver = createFileTreeIconResolver({ set: 'complete', colored: true });
  const spriteSheet = getBuiltInSpriteSheet('complete');
  for (const extension of EXTENSIONS) {
    const resolved = resolver.resolveIcon('file-tree-icon-file', `file.${extension}`);
    const symbol = new RegExp(`<symbol id="${resolved.name}" viewBox="([^"]+)">([\\s\\S]*?)</symbol>`).exec(spriteSheet);
    if (!symbol) continue;
    const body = symbol[2].replaceAll('currentColor', 'black').replaceAll('currentcolor', 'black');
    const color = resolved.token ? `var(--trees-file-icon-color-${resolved.token}, var(--trees-fg-muted))` : 'var(--trees-fg-muted)';
    const row = endsWith(`.${extension}${FILE_MARK}`, true);
    rules.push(`${row} > [data-item-section="icon"] { width:auto; gap:2px; }`);
    rules.push(`${row} > [data-item-section="icon"]::after { ${afterIcon(maskOf(body, symbol[1]), color).replace('14px 14px', '16px 16px')} }`);
  }
  // The symbol the reader is in (lib/tree-symbol-sync.ts) carries the one status no file has here.
  rules.push(
    `[data-item-git-status="untracked"] { background:color-mix(in oklab, var(--trees-theme-list-active-selection-bg, var(--accent)) 55%, transparent); box-shadow:inset 2px 0 0 var(--trees-focus-ring-color); }`,
    `[data-item-git-status="untracked"] > [data-item-section="content"] { color:var(--trees-fg) !important; font-weight:var(--trees-font-weight-semibold); }`,
    `[data-item-git-status="untracked"] > [data-item-section="icon"] { opacity:1 !important; }`,
    `[data-item-git-status="untracked"] > [data-item-section="git"] { visibility:hidden; }`,
    // Symbol rows have no Git status of their own: the dot that marks a folder holding the lit row stays off them.
    `:is([data-item-path$=${cssString(CODE_END)}], [data-item-path$=${cssString(`${CODE_END}/`)}]) > [data-item-section="git"] { visibility:hidden; }`
  );
  built = { icons, css: rules.join('\n') };
  return built;
}
