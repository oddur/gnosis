import type { ReviewGuide } from './types';

interface AllChecksSummary {
  /** Multi-section markdown prompt ready to paste into an agent. */
  prompt: string;
  /** Total check count across the review — for the button label and the
   *  zero-check guard so we don't render an empty affordance. */
  count: number;
}

/**
 * Walk every slide and concatenate the "What to check" items into a single
 * agent prompt. Each section names the slide so the agent can group its
 * findings the same way; anchored checks include `file:line` hints so it
 * doesn't need to grep around to locate them.
 *
 * Slides without any checks are skipped silently — they'd just be visual
 * noise in the prompt. Returns `count: 0` when the review has no checks
 * anywhere; callers should hide the affordance in that case.
 */
export function buildAllChecksPrompt(review: ReviewGuide): AllChecksSummary {
  const sections: string[] = [];
  let count = 0;

  for (const slide of review.slides) {
    const checks = slide.reviewChecks ?? [];
    if (checks.length === 0) continue;

    const slideHeader = `## ${slide.slideNumber.toString().padStart(2, '0')} — ${slide.title}`;
    const items = checks.map((c) => {
      const anchor = c.filePath
        ? ` _(${c.filePath}${c.startLine ? `:${c.startLine}` : ''})_`
        : '';
      return `- ${c.text.trim()}${anchor}`;
    });
    sections.push([slideHeader, ...items].join('\n'));
    count += checks.length;
  }

  if (count === 0) {
    return { prompt: '', count: 0 };
  }

  const intro = [
    `You are investigating a code review of: **${review.prTitle}**`,
    '',
    `Source: ${review.prUrl}`,
    '',
    `Below is the full set of "what to check" items the reviewer surfaced — ${count} check${count === 1 ? '' : 's'} across ${sections.length} slide${sections.length === 1 ? '' : 's'}. For each one, investigate against the code and report whether the concern is **valid**, **handled**, or **unclear**, with file:line evidence. Group your response by slide so it's easy to map findings back to the review.`,
    '',
    '---',
    '',
  ].join('\n');

  return { prompt: intro + sections.join('\n\n'), count };
}
