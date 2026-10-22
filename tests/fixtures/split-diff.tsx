import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SplitDiffHunkGroup } from '../../components/SplitDiffHunk';
import { renderDiffHunk } from '../../lib/highlight';
import type { DiffHunk, PendingReviewComment } from '../../lib/types';
import '../../src/globals.css';

const cases = [
  ['added', '@@ -0,0 +1,2 @@', '+export const ready = true;\n+export const limit = 10;'],
  ['deleted', '@@ -1,2 +0,0 @@', '-export const ready = true;\n-export const limit = 10;'],
  ['insert', '@@ -3,0 +4,2 @@', '+export const ready = true;\n+export const limit = 10;'],
  ['modify', '@@ -1 +1 @@', '-export const ready = false;\n+export const ready = true;'],
  ['added-plain', '@@ -0,0 +1,2 @@', 'export const ready = true;\nexport const limit = 10;'],
];
const hunks: DiffHunk[] = await Promise.all(
  cases.map(async ([name, hunkHeader, content]) => ({
    filePath: name + '.ts',
    hunkHeader,
    content,
    language: 'typescript',
    renderedHtml: await renderDiffHunk(content, 'typescript', 'github-dark', hunkHeader),
  }))
);
function Fixture() {
  const [comments, setComments] = useState<PendingReviewComment[]>([]);
  return (
    <main style={{ width: 650, maxWidth: '100%', padding: 16 }}>
      {hunks.map((hunk, index) => (
        <section key={hunk.filePath} data-case={cases[index][0]} style={{ marginBottom: 24 }}>
          <h2>{cases[index][0]}</h2>
          <SplitDiffHunkGroup
            filePath={hunk.filePath}
            hunks={[hunk]}
            pendingComments={comments}
            commentCallbacks={
              index === 4
                ? undefined
                : {
                    onAddComment: (comment) =>
                      setComments((current) => [...current, { ...comment, id: String(current.length) }]),
                    onRemoveComment: (id) => setComments((current) => current.filter((c) => c.id !== id)),
                    onEditComment: (id, body) =>
                      setComments((current) => current.map((c) => (c.id === id ? { ...c, body } : c))),
                  }
            }
          />
        </section>
      ))}
      <output id="comments">{JSON.stringify(comments)}</output>
    </main>
  );
}
document.documentElement.classList.add('dark');
const root = document.getElementById('root');
if (root) createRoot(root).render(<Fixture />);
