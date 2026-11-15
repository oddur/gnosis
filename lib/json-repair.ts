/**
 * Tolerant parsing for JSON written by a model. Valid JSON is parsed as is. Only text that
 * `JSON.parse` rejects is repaired, for the breakage models produce in practice:
 * - prose or Markdown fences around the object,
 * - unescaped double quotes inside strings, such as code like `CMD ["node", "-v"]`,
 * - raw newlines, tabs and invalid escapes such as `\$` inside strings,
 * - comments and trailing commas,
 * - truncated output, which is closed so complete fields survive.
 */

type Frame = 'object' | 'array';

/** The JSON object in a response: the text from the first `{` to its matching `}`, without fences or prose. */
export function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  if (start === -1) return text.trim();
  let depth = 0,
    inString = false,
    escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      const candidate = text.slice(start, i + 1);
      // A quote miscount can end the scan early. Prefer the last brace when it gives valid JSON.
      const end = text.lastIndexOf('}');
      if (end > i) {
        const wider = text.slice(start, end + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          return wider;
        }
      }
      return candidate;
    }
  }
  // Unbalanced quotes or truncation: keep through the last brace, without trailing prose or fences.
  const end = text.lastIndexOf('}');
  return (end > start ? text.slice(start, end + 1) : text.slice(start)).trim();
}

const KEY_START = /^"(?:[^"\\\n]|\\.)*"\s*:/;
const VALUE_START = /^(?:["{[\]\-0-9]|true\b|false\b|null\b)/;

/** Text without leading whitespace and comments. */
function skipTrivia(text: string): string {
  let rest = text.trimStart();
  while (rest.startsWith('//') || rest.startsWith('/*')) {
    const end = rest.startsWith('//') ? rest.indexOf('\n') : rest.indexOf('*/');
    rest = end === -1 ? '' : rest.slice(end + (rest.startsWith('//') ? 1 : 2)).trimStart();
  }
  return rest;
}

/** Whether a quote at `i` ends the current string, judged by what a valid document needs next. */
function closesString(text: string, i: number, frame: Frame | undefined, isKey: boolean): boolean {
  const rest = skipTrivia(text.slice(i + 1));
  if (!rest) return true;
  const next = rest[0];
  if (isKey) return next === ':';
  const afterComma = next === ',' ? skipTrivia(rest.slice(1)) : undefined;
  if (frame === 'object')
    return next === '}' || (afterComma !== undefined && (KEY_START.test(afterComma) || afterComma.startsWith('}')));
  if (frame === 'array') return next === ']' || (afterComma !== undefined && VALUE_START.test(afterComma));
  return true;
}

/** Repair common model breakage. The result is valid JSON when the damage is one of the documented kinds. */
export function repairJson(input: string): string {
  const text = extractJsonObject(input);
  const stack: Frame[] = [];
  // For objects: whether the next string is a key.
  const expectKey: boolean[] = [];
  let out = '';
  let inString = false,
    isKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const frame = stack[stack.length - 1];
    if (inString) {
      if (c === '\\') {
        const n = text[i + 1];
        if (n && '"\\/bfnrt'.includes(n)) {
          out += c + n;
          i++;
        } else if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
          out += text.slice(i, i + 6);
          i += 5;
        } else out += '\\\\';
        continue;
      }
      if (c === '"') {
        if (closesString(text, i, frame, isKey)) {
          inString = false;
          out += c;
        } else out += '\\"';
        continue;
      }
      if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else if (c < ' ') out += '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
      else out += c;
      continue;
    }
    if (c === '"') {
      inString = true;
      isKey = frame === 'object' && expectKey[expectKey.length - 1];
      out += c;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (c === '{' || c === '[') {
      stack.push(c === '{' ? 'object' : 'array');
      expectKey.push(c === '{');
      out += c;
      continue;
    }
    if (c === '}' || c === ']') {
      out = out.replace(/,\s*$/, '');
      stack.pop();
      expectKey.pop();
      out += c;
      continue;
    }
    if (c === ':' && frame === 'object') expectKey[expectKey.length - 1] = false;
    if (c === ',' && frame === 'object') expectKey[expectKey.length - 1] = true;
    out += c;
  }
  // Truncated output: close the open string and containers, dropping a dangling key or separator.
  if (inString) out += '"';
  if (stack.length) {
    out = out.trimEnd();
    if (stack[stack.length - 1] === 'object' && expectKey[expectKey.length - 1] && out.endsWith('"'))
      out = out.replace(/,?\s*"(?:[^"\\]|\\.)*"$/, '');
    out = out.trimEnd();
    if (out.endsWith(':')) out += 'null';
    else if (out.endsWith(',')) out = out.slice(0, -1);
    for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === 'object' ? '}' : ']';
  }
  return out;
}

/** Parse a model's JSON response, repairing it when strict parsing fails. Throws the strict parser's error. */
export function parseModelJson(text: string): unknown {
  const extracted = extractJsonObject(text);
  try {
    return JSON.parse(extracted);
  } catch (error) {
    try {
      return JSON.parse(repairJson(text));
    } catch {
      throw error;
    }
  }
}

/** A short excerpt around a JSON.parse error position, for logs. */
export function jsonErrorExcerpt(text: string, error: unknown, radius = 80): string | undefined {
  const match = /position (\d+)/.exec(error instanceof Error ? error.message : String(error));
  if (!match) return undefined;
  const position = Number(match[1]);
  const extracted = extractJsonObject(text);
  return JSON.stringify(extracted.slice(Math.max(0, position - radius), position + radius));
}
