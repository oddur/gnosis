import type { GenerateOptions } from '../provider';

// No Node imports: browser fixtures replay recorded streams through this parser.
/**
 * Parse `claude -p --output-format stream-json --verbose --include-partial-messages`.
 * Text arrives as partial deltas; complete `tool_use` blocks, with their input,
 * arrive in `assistant` messages. A partial `content_block_start` only names the tool.
 */
export function createClaudeEventHandler({
  onChunk,
  onToolUse,
  onToolCall,
}: Pick<GenerateOptions, 'onChunk' | 'onToolUse' | 'onToolCall'>) {
  let fullText = '';
  let streamError = '';
  const calls = new Set<string>();
  return {
    processLine: (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const outer = JSON.parse(trimmed) as Record<string, unknown>;
        if (outer.type === 'result') {
          if (outer.is_error === true && typeof outer.result === 'string') {
            streamError = outer.result;
          } else if (typeof outer.result === 'string') {
            fullText = outer.result;
          }
          return;
        }
        if (outer.type === 'assistant') {
          const message = outer.message as { content?: unknown } | undefined;
          for (const block of Array.isArray(message?.content) ? message.content : []) {
            const b = block as Record<string, unknown> | null;
            if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
            const id = typeof b.id === 'string' ? b.id : undefined;
            if (id && calls.has(id)) continue;
            if (id) calls.add(id);
            const input = b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : undefined;
            onToolCall?.({ id, name: b.name, input });
          }
          return;
        }
        if (outer.type !== 'stream_event') return;
        const inner = outer.event as Record<string, unknown> | undefined;
        if (!inner) return;
        if (inner.type === 'content_block_start') {
          const block = inner.content_block as Record<string, unknown> | undefined;
          if (block?.type === 'tool_use' && typeof block.name === 'string') {
            onToolUse?.(block.name);
          }
          return;
        }
        if (inner.type !== 'content_block_delta') return;
        const delta = inner.delta as Record<string, unknown> | undefined;
        if (!delta) return;
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          onChunk?.(delta.thinking, true);
        } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          fullText += delta.text;
          onChunk?.(delta.text, false);
        }
      } catch {
        // not a JSON event
      }
    },
    getText: () => fullText,
    getError: () => streamError,
  };
}
