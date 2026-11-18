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
/** Each glob compiles once: a large repository's .gitattributes against every file of a PR rebuilt thousands of
 * regular expressions per classification and blocked the main process for seconds (diagnostics, 2026-11-18). */
const compiled = new Map<string, { regex: RegExp; anchored: boolean } | null>();
function compile(pattern: string): { regex: RegExp; anchored: boolean } | null {
  const known = compiled.get(pattern);
  if (known !== undefined) return known;
  let value: { regex: RegExp; anchored: boolean } | null = null;
  if (pattern && !pattern.startsWith('!') && !pattern.endsWith('/')) {
    const anchored = pattern.includes('/');
    const body = pattern.replace(/^\//, '');
    let regex = '';
    let valid = true;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === '*') {
        if (body[i + 1] === '*') {
          i++;
          if (body[i + 1] === '/') {
            regex += '(?:.*/)?';
            i++;
          } else regex += '.*';
        } else regex += '[^/]*';
      } else if (c === '?') regex += '[^/]';
      else if (c === '[') {
        const end = body.indexOf(']', i + 1);
        if (end < 0) {
          valid = false;
          break;
        }
        const group = body.slice(i + 1, end).replace(/^!/, '^');
        regex += `[${group}]`;
        i = end;
      } else if (c === '\\' && i + 1 < body.length) regex += body[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      else regex += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    if (valid) {
      try {
        value = { regex: new RegExp(`^${regex}$`), anchored };
      } catch {
        value = null;
      }
    }
  }
  if (compiled.size > 5000) compiled.clear();
  compiled.set(pattern, value);
  return value;
}
function matches(pattern: string, relative: string): boolean {
  const glob = compile(pattern);
  return !!glob && glob.regex.test(glob.anchored ? relative : (relative.split('/').at(-1) ?? ''));
}
interface Rule {
  file: AttributeFile;
  dir: string;
  pattern: string;
  attrs: string[];
}
/** Parsed once per set of attribute files, then reused for every path of the PR. */
const parsed = new WeakMap<AttributeFile[], { rules: Rule[]; macros: Map<string, string[]> }>();
function parse(files: AttributeFile[]) {
  const known = parsed.get(files);
  if (known) return known;
  const rules: Rule[] = [];
  const macros = new Map<string, string[]>();
  for (const file of [...files].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    const dir = file.path.slice(0, -'.gitattributes'.length);
    for (const raw of file.text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const [pattern, ...attrs] = tokens(line);
      if (!pattern) continue;
      if (pattern.startsWith('[attr]')) {
        if (!dir) macros.set(pattern.slice(6), attrs);
        continue;
      }
      rules.push({ file, dir, pattern, attrs });
    }
  }
  const value = { rules, macros };
  parsed.set(files, value);
  return value;
}
export function generatedAttribute(
  path: string,
  files: AttributeFile[]
): { value: boolean; reason: string } | undefined {
  let result: { value: boolean; reason: string } | undefined;
  const { rules, macros } = parse(files);
  const expand = (items: string[], seen = new Set<string>()): string[] =>
    items.flatMap((a) => {
      const macro = macros.get(a);
      if (!macro || seen.has(a)) return [a];
      return expand(macro, new Set([...seen, a]));
    });
  for (const { file, dir, pattern, attrs } of rules) {
    if (!path.startsWith(dir)) continue;
    if (!matches(pattern, path.slice(dir.length))) continue;
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
  return result;
}
