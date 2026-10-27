/** The subset of Git attributes relevant to generated-file classification. */
export interface AttributeFile {
  path: string;
  text: string;
}
function tokens(line: string): string[] {
  // Git supports C-quoted paths, including spaces; comments start at the beginning of a line.
  return (
    line.match(/"(?:\\.|[^"\\])*"|\S+/g)?.map((t) => {
      if (!t.startsWith('"')) return t;
      try {
        return JSON.parse(t) as string;
      } catch {
        return '';
      }
    }) ?? []
  );
}
function matches(pattern: string, relative: string): boolean {
  if (!pattern || pattern.startsWith('!') || pattern.endsWith('/')) return false;
  const anchored = pattern.includes('/');
  pattern = pattern.replace(/^\//, '');
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          regex += '(?:.*/)?';
          i++;
        } else regex += '.*';
      } else regex += '[^/]*';
    } else if (c === '?') regex += '[^/]';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) return false;
      const group = pattern.slice(i + 1, end).replace(/^!/, '^');
      regex += `[${group}]`;
      i = end;
    } else if (c === '\\' && i + 1 < pattern.length) regex += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else regex += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  try {
    return new RegExp(`^${regex}$`).test(anchored ? relative : (relative.split('/').at(-1) ?? ''));
  } catch {
    return false;
  }
}
export function generatedAttribute(
  path: string,
  files: AttributeFile[]
): { value: boolean; reason: string } | undefined {
  let result: { value: boolean; reason: string } | undefined;
  const macros = new Map<string, string[]>();
  for (const file of [...files].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    const dir = file.path.slice(0, -'.gitattributes'.length);
    if (!path.startsWith(dir)) continue;
    for (const raw of file.text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const [pattern, ...attrs] = tokens(line);
      if (!pattern) continue;
      if (pattern.startsWith('[attr]')) {
        if (!dir) macros.set(pattern.slice(6), attrs);
        continue;
      }
      if (!matches(pattern, path.slice(dir.length))) continue;
      const expand = (items: string[], seen = new Set<string>()): string[] =>
        items.flatMap((a) => {
          const macro = macros.get(a);
          if (!macro || seen.has(a)) return [a];
          return expand(macro, new Set([...seen, a]));
        });
      for (const attr of expand(attrs)) {
        if (attr === '!linguist-generated') result = undefined;
        if (
          ['linguist-generated', 'linguist-generated=true', '-linguist-generated', 'linguist-generated=false'].includes(
            attr
          )
        )
          result = {
            value: attr === 'linguist-generated' || attr === 'linguist-generated=true',
            reason: `${file.path}: ${pattern} ${attr}`,
          };
      }
    }
  }
  return result;
}
