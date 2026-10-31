import { getSharedHighlighter, getHighlighterType } from '@pierre/diffs';
import { DIFF_HIGHLIGHTER } from '../../lib/diff-highlighter';

export { getHighlighterType };
export async function loadSelectedHighlighter() {
  return (
    await getSharedHighlighter({
      preferredHighlighter: DIFF_HIGHLIGHTER,
      themes: ['gnosis-github-dark'],
      langs: ['typescript'],
    })
  ).name;
}
