import { parseChatSelection } from './chat-selection';
/**
 * Selections are attachments in the UI and explicit context in model messages: where the code sits (file, side and
 * lines, lib/chat-selection.ts), then the code in a fence long enough to hold any backticks in it.
 */
export function chatQuestion(content: string, selection?: string | null) {
  if (!selection) return content;
  const { code, path, side, startLine, endLine } = parseChatSelection(selection);
  const fence = '`'.repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map((run) => run.length + 1)));
  const lines = startLine
    ? `${side === 'before' ? 'old' : 'new'} ${endLine && endLine !== startLine ? `lines ${startLine}–${endLine}` : `line ${startLine}`}`
    : '';
  const where = path ? ` in ${path}${lines ? `, ${lines}` : ''}` : lines ? ` (${lines})` : '';
  return `Regarding this code${where}:\n${fence}\n${code}\n${fence}\n\n${content}`;
}

export function chatSuggestions(context: {
  title?: string;
  path?: string;
  focus?: string | null;
  selection?: boolean;
}) {
  const { title, path, focus, selection } = context;
  if (selection) return ['How does this selected code work?', 'What could go wrong in this selected code?'];
  const lower = `${focus ?? ''} ${title ?? ''} ${path ?? ''}`.toLowerCase();
  const risk = /auth|permission|security|token/.test(lower)
    ? 'Which permission checks matter here?'
    : /queue|worker|cancel|retry|async/.test(lower)
      ? 'What happens if this work fails or is cancelled?'
      : /test|spec/.test(lower)
        ? 'Which behavior do these tests cover, and what is missing?'
        : /performance|scal|cache/.test(lower)
          ? 'How does this change affect performance or stale data?'
          : /schema|migration|database/.test(lower)
            ? 'How does this affect existing data?'
            : 'Which edge cases matter for this change?';
  return [
    path
      ? `What changes in ${path.split('/').at(-1) ?? path}?`
      : title
        ? `Explain “${title}” using the changed code.`
        : 'How does this change work?',
    risk,
  ];
}
