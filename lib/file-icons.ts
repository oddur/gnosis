/// <reference types="vite/client" />
import minimal from '@pierre/vscode-icons/scripts/themes/minimal.mjs';
import defaults from '@pierre/vscode-icons/scripts/themes/default.mjs';
import complete from '@pierre/vscode-icons/scripts/themes/complete.mjs';
import { fill } from '@pierre/vscode-icons/scripts/palette.mjs';

// The published package ships source SVGs and mappings. Bundle them locally,
// applying the same palette and duo-tone rules as Pierre's icon-theme builder.
const sources = import.meta.glob<string>('/node_modules/@pierre/vscode-icons/svgs/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
});
const definitions = [...minimal, ...defaults, ...complete];
const icons = new Map(definitions.map((icon) => [icon.name, icon]));
const filenames = new Map(
  definitions.flatMap((icon) => (icon.fileNames ?? []).map((name) => [name.toLowerCase(), icon.name]))
);
const extensions = new Map(
  definitions.flatMap((icon) => (icon.fileExtensions ?? []).map((ext) => [ext.toLowerCase(), icon.name]))
);
const cache = new Map<string, { name: string; light: string; dark: string }>();

export function fileIcon(filePath: string) {
  const filename = filePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  let name = filenames.get(filename);
  // Match compound suffixes first, e.g. .env.production before .production.
  if (!name) {
    const parts = filename.split('.');
    for (let i = parts.length > 1 ? 1 : 0; i < parts.length && !name; i++) {
      name = extensions.get(parts.slice(i).join('.'));
    }
  }
  name ??= 'file-duo';
  const cached = cache.get(name);
  if (cached) return cached;
  const icon = icons.get(name) ?? icons.get('file-duo');
  const source =
    sources[`/node_modules/@pierre/vscode-icons/svgs/${icon?.svgName ?? name}.svg`] ??
    sources['/node_modules/@pierre/vscode-icons/svgs/file-duo.svg'];
  const urls = { name, light: '', dark: '' };
  for (const mode of ['light', 'dark'] as const) {
    const color = icon?.color ?? fill;
    const foreground = 'fg' in color ? color.fg[mode] : color[mode];
    let svg = source.replace(/currentColor/g, foreground);
    if ('bg' in color) svg = svg.replace('>', `><style>.bg{fill:${color.bg[mode]}}</style>`);
    if (icon?.opacity) svg = svg.replace('<svg', `<svg opacity="${icon.opacity}"`);
    urls[mode] = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }
  cache.set(name, urls);
  return urls;
}
