import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChangesCommentComposer } from '../../components/ChangesCommentComposer';
import { MarkdownCommentEditor } from '../../components/MarkdownCommentEditor';
import { CommentMarkdown } from '../../components/CommentMarkdown';
import '../../src/globals.css';
Object.assign(window, { electronAPI: { openExternal: async () => {}, loadPrImage: () => Promise.resolve('') } });
function Fixture() {
  const [saved, setSaved] = useState('');
  const [other, setOther] = useState('Separate draft');
  const [disabled, setDisabled] = useState(false);
  return (
    <main style={{ maxWidth: 720, margin: '24px auto', padding: 16 }}>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>Review comment</h1>
      <ChangesCommentComposer
        draftKey="editor-fixture"
        label="Comment on src/queue.ts:12"
        onSave={(body) => {
          setSaved(body);
          return Promise.resolve();
        }}
        onCancel={() => {}}
      />
      <div id="saved">
        <CommentMarkdown>{saved}</CommentMarkdown>
      </div>
      <output id="saved-source" hidden>
        {saved}
      </output>
      <div style={{ marginTop: 24 }}>
        <label htmlFor="other-draft">Another comment</label>
        <MarkdownCommentEditor id="other-draft" value={other} onValueChange={setOther} disabled={disabled} />
        <button onClick={() => setDisabled(!disabled)}>Toggle disabled</button>
      </div>
    </main>
  );
}
const container = document.getElementById('root');
if (container) createRoot(container).render(<Fixture />);
