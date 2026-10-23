import ReactMarkdown from 'react-markdown';
import type { InlineExplanation } from '../lib/types';

export function InlineCodeExplanation({ explanation }: { explanation: InlineExplanation }) {
  return (
    <aside className="inline-code-explanation" aria-label="Code explanation">
      <ReactMarkdown allowedElements={['p', 'code', 'strong', 'em']} unwrapDisallowed skipHtml>
        {explanation.text}
      </ReactMarkdown>
    </aside>
  );
}
