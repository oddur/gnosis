import ReactMarkdown from 'react-markdown';
import type { InlineExplanation } from '../lib/types';

export function InlineCodeExplanation({ explanation }: { explanation: InlineExplanation }) {
  return (
    <aside className="inline-code-explanation" aria-label="Gnosis explanation">
      <span className="inline-code-explanation-label">Gnosis explanation</span>
      <ReactMarkdown allowedElements={['p', 'code', 'strong', 'em']} unwrapDisallowed skipHtml>
        {explanation.text}
      </ReactMarkdown>
    </aside>
  );
}
