/** Selections are attachments in the UI and explicit context in model messages. */
export function chatQuestion(content: string, selection?: string | null) {
  return selection ? `Regarding this code:\n\`\`\`\n${selection}\n\`\`\`\n\n${content}` : content;
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
