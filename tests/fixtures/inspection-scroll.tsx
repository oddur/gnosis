import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChangesFileTree } from '../../components/ChangesFileTree';
import '../../src/globals.css';

const files = Array.from({ length: 160 }, (_, i) => ({
  key: `file-${String(i).padStart(3, '0')}.ts`,
  status: 'modified' as const,
  viewed: false,
  additions: 1,
  deletions: 1,
}));
function Fixture() {
  const [comments, setComments] = useState(0);
  const [extra, setExtra] = useState(false);
  const [selected, setSelected] = useState(files[0].key);
  return (
    <>
      <button onClick={() => setComments((n) => n + 1)}>Update comments</button>
      <button onClick={() => setExtra(true)}>Add file</button>
      <button onClick={() => setSelected(files[files.length - 1].key)}>Select last file</button>
      <div style={{ display: 'flex', height: 500 }}>
        <div style={{ width: 380, height: '100%', overflow: 'auto' }}>
          <ChangesFileTree
            entries={[...files, ...(extra ? [{ ...files[0], key: 'new-file.ts' }] : [])].map((f) => ({
              ...f,
              commentCount: comments,
            }))}
            selected={selected}
            query=""
            onSelect={setSelected}
            revealSelected
          />
        </div>
      </div>
    </>
  );
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<Fixture />);
