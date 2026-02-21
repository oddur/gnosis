import type { SendSlideChatRequest } from './types';

const MAX_HISTORY_MESSAGES = 10;

export function buildSlideChatSystemPrompt(): string {
  return `You are a senior engineer helping a code reviewer understand a specific set of changes in a pull request. Answer follow-up questions about these code changes. Be direct and concrete. Reference the actual code when helpful. Keep answers focused on what the reviewer needs to understand.`;
}

export function buildSlideChatUserMessage(req: SendSlideChatRequest): string {
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
Review focus: ${req.slideReviewFocus}
Affected files: ${req.affectedFiles.join(', ')}
</slide_context>`);

  if (req.diffContent) {
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
