import type { SendSlideChatRequest } from './types';
import { CHAT_CITATION_INSTRUCTION } from './chat-citations';

const MAX_HISTORY_MESSAGES = 10;

export function buildSlideChatSystemPrompt(): string {
  return `You are a senior engineer helping a code reviewer understand a specific set of changes in a pull request. Answer follow-up questions about these code changes. Be direct and concrete. Reference the actual code when helpful. Keep answers focused on what the reviewer needs to understand. ${CHAT_CITATION_INSTRUCTION}`;
}

/** `prContext`: the PR-wide context (lib/chat-pr-context.ts); it replaces the topic's own diff, which it holds. */
export function buildSlideChatUserMessage(req: SendSlideChatRequest, prContext?: string): string {
  const historySlice = req.history.slice(-MAX_HISTORY_MESSAGES);

  const parts: string[] = [];

  parts.push(`<pr_context>
Title: ${req.prTitle}
Summary: ${req.summary}
Description: ${req.prDescription}
</pr_context>`);

  parts.push(`<slide_context>
Title: ${req.slideTitle}
Narrative: ${req.slideNarrative}
Review focus: ${req.slideReviewFocus ?? 'N/A'}
Affected files: ${req.affectedFiles.join(', ')}
</slide_context>`);

  if (prContext) {
    parts.push(`<pr_wide_context>
${prContext}
</pr_wide_context>`);
  } else if (req.diffContent) {
    parts.push(`<diff>
${req.diffContent}
</diff>`);
  }

  if (historySlice.length > 0) {
    const formatted = historySlice
      .map((m) => `${m.role === 'user' ? 'Reviewer' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    parts.push(`<conversation_history>
${formatted}
</conversation_history>`);
  }

  parts.push(`Question: ${req.question}`);

  return parts.join('\n\n');
}
