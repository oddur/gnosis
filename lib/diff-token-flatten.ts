import { FileDiff } from '@pierre/diffs';
import { flattenLine, type Hast } from './token-gradient';

export { FLAT_TOKENS, FLAT_TOKEN_CSS } from './token-gradient';

type Rendered = Partial<Record<'unifiedContentAST' | 'deletionsContentAST' | 'additionsContentAST', Hast[]>>;
const prototype = FileDiff.prototype as unknown as {
  options: Record<string, unknown>;
  applyHunksToDOM(pre: HTMLElement, result: Rendered): void;
};
/**
 * Pierre writes a diff's lines in `applyHunksToDOM`. Diffs with `FLAT_TOKENS` in their options get one text node per
 * line (lib/token-gradient.ts); the lines are changed before Pierre writes them, so this adds no DOM work.
 */
const apply = prototype.applyHunksToDOM;
if (typeof apply === 'function')
  prototype.applyHunksToDOM = function (pre, result) {
    if (this.options.gnosisFlatTokens && this.options.overflow !== 'wrap')
      for (const lines of [result.unifiedContentAST, result.deletionsContentAST, result.additionsContentAST])
        if (lines) for (let i = 0; i < lines.length; i++) flattenLine(lines[i]);
    apply.call(this, pre, result);
  };
