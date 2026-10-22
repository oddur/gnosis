import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SlideView } from '../../components/SlideView';
import { slide } from './explainer';
import { ReviewDiff } from '../../components/ReviewDiff';
import { DiffAppearanceMenu } from '../../components/DiffAppearanceMenu';
import { DEFAULT_DIFF_APPEARANCE } from '../../lib/review-diff';
import { renderDiffHunk } from '../../lib/highlight';
import type { DiffHunk, PendingReviewComment } from '../../lib/types';
import '../../src/globals.css';

const cases = [
  ['added', '@@ -0,0 +1,2 @@', '+export const ready = true;\n+export const limit = 10;'],
  ['deleted', '@@ -1,2 +0,0 @@', '-export const ready = true;\n-export const limit = 10;'],
  ['insert', '@@ -3,0 +4,2 @@', '+export const ready = true;\n+export const limit = 10;'],
  ['modify', '@@ -1 +1 @@', '-export const ready = false;\n+export const ready = true;'],
  ['metadata-added', '@@ -1,1 +1,3 @@', '+export const ready = true;\n+export const limit = 10;\n '],
  ['metadata-deleted', '@@ -1,3 +1,1 @@', '-export const ready = true;\n-export const limit = 10;\n '],
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
  const [selectedCode, setSelectedCode] = useState('');
  const [appearance, setAppearance] = useState(DEFAULT_DIFF_APPEARANCE);
  const [comments, setComments] = useState<PendingReviewComment[]>([]);
  return (
    <main style={{ width: 650, maxWidth: '100%', padding: 16 }}>
      <DiffAppearanceMenu value={appearance} onChange={setAppearance} />
      {hunks.map((hunk, index) => (
        <section key={hunk.filePath} data-case={cases[index][0]} style={{ marginBottom: 24 }}>
          <h2>{cases[index][0]}</h2>
          {cases[index][0].startsWith('metadata-') ? (
            <SlideView
              slide={{
                ...slide,
                diffHunks: [hunk],
                mermaidDiagram: undefined,
                affectedFiles: [hunk.filePath],
                reviewChecks: [{ text: 'Verify the ready flag', filePath: hunk.filePath, startLine: 1 }],
              }}
              onAskAboutSelection={setSelectedCode}
              slideNumber={1}
              totalSlides={1}
              prUrl="https://github.com/example/repo/pull/1"
              checkedChecks={new Set()}
              onToggleCheck={() => {}}
              diffLayout="split"
              onDiffLayoutChange={() => {}}
              viewMode="focus"
              fileMetadataMap={
                new Map([
                  [
                    hunk.filePath,
                    {
                      filename: hunk.filePath,
                      status: cases[index][0] === 'metadata-added' ? 'added' : 'deleted',
                      additions: 2,
                      deletions: 0,
                    },
                  ],
                ])
              }
            />
          ) : (
            <ReviewDiff
              diffLayout="split"
              slideIndex={1}
              appearance={appearance}
              filePath={hunk.filePath}
              hunks={[hunk]}
              pendingComments={comments}
              commentCallbacks={
                cases[index][0] === 'added-plain'
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
          )}
        </section>
      ))}
      <output id="selected-code">{selectedCode}</output>
      <output id="comments">{JSON.stringify(comments)}</output>
    </main>
  );
}
document.documentElement.classList.add('dark');
const root = document.getElementById('root');
if (root) createRoot(root).render(<Fixture />);
