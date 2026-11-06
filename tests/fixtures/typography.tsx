import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import '../../src/globals.css';
import { Markdown } from '../../components/Markdown';
import { CommentMarkdown } from '../../components/CommentMarkdown';
import { MarkdownReviewPreview } from '../../components/MarkdownReviewPreview';

const narrative = `The worker now checks ownership before it publishes a result. A cancelled request cannot replace a newer result.

## Keep the latest result

- **Claim:** save the request's generation when work starts.
- **Check:** compare that generation before publishing.
  - A matching generation can publish.
  - An older generation must stop.

### Reject a stale response

Cancellation alone does not stop work that has already reached the server. The generation check covers that gap.

### Preserve the retry path

A retry uses the same request key. It must keep the ownership check before it writes the result.

> The check and the write must happen in the same transaction.

\`\`\`typescript
if (pending.generation !== request.generation) return;
await publish(result);
\`\`\`

## What stays the same

The queue order and public API are unchanged. Only the final write gains a guard.`;
const document = `# Safe publication

A request can finish after its caller has cancelled it. Only the current owner can publish a result.

## Ownership rules

The server records an owner and a generation for each request.

### Claim a request

Save the generation before work begins. Keep this value with the request through retries.

#### Handle retries

Compare the saved generation with the current record.

##### Duplicate requests

Use the same key to find an existing result.

###### Recovery details

Keep the existing result until the replacement is confirmed.

- Confirm the owner before writing.
  - Match the generation too.
- Preserve the old result if confirmation fails.

| Outcome | Result |
| --- | --- |
| Current generation | Publish the result |
| Stale generation | Keep the existing result |

\`\`\`typescript
const owner = await requests.findByKey("a-long-request-key-that-must-scroll-within-the-code-block-without-widening-the-reading-pane");
\`\`\``;
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);
const tree = processor.runSync(processor.parse(document));
function Specimen() {
  const [surface, setSurface] = useState('Explanation');
  return (
    <div style={{ minHeight: '100vh', background: 'var(--background)', color: 'var(--foreground)' }}>
      <nav
        aria-label="Reading surfaces"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 16, padding: 20, borderBottom: '1px solid var(--border)' }}
      >
        {['Explanation', 'PR description', 'Chat', 'Comment', 'Markdown preview'].map((label) => (
          <button key={label} aria-pressed={label === surface} onClick={() => setSurface(label)}>
            {label}
          </button>
        ))}
      </nav>
      <main style={{ maxWidth: 920, padding: '24px clamp(16px, 4vw, 40px)', marginInline: 'auto' }}>
        <h1 className="slide-title" style={{ marginBottom: 24 }}>
          Publish only the current request
        </h1>
        <section data-reading-surface={surface}>
          {surface === 'Explanation' && (
            <div className="review-narrative">
              <Markdown className="slide-prose">{narrative}</Markdown>
            </div>
          )}
          {surface === 'PR description' && (
            <div className="pr-description">
              <Markdown className="pr-markdown" githubSource={{ repo: 'o/r', ref: 'head' }} headingLevel={4}>
                {document}
              </Markdown>
            </div>
          )}
          {surface === 'Chat' && <Markdown className="reading-prose chat-message-body">{narrative}</Markdown>}
          {surface === 'Comment' && <CommentMarkdown>{document}</CommentMarkdown>}
          {surface === 'Markdown preview' && (
            <MarkdownReviewPreview
              review={{
                clean: tree,
                blocks: [{ id: 'all', change: 'unchanged', tree }],
                deleted: false,
                sourceOnly: false,
              }}
              showChanges={false}
              onChanges={() => {}}
              onSource={() => {}}
              annotations={[]}
              canComment={false}
            />
          )}
        </section>
      </main>
    </div>
  );
}
const root = window.document.getElementById('root');
if (!root) throw new Error('Missing typography fixture root');
createRoot(root).render(<Specimen />);
