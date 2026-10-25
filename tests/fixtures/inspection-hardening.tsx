import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PrFileChat } from '../../components/PrFileChat';
import { ChangesFileResize } from '../../components/ChangesFileResize';
import { ChangesCommentComposer } from '../../components/ChangesCommentComposer';
import { SubmitReviewDialog } from '../../components/SubmitReviewDialog';
import { ReviewImageDiff } from '../../components/ReviewImageDiff';
import { Button } from '../../components/ui/button';
import { DEFAULT_CLAUDE_MODEL, DEFAULT_FAST_CLAUDE_MODEL } from '../../lib/models';
import type { Preferences } from '../../lib/types';
import '../../src/globals.css';
let prefs: Preferences = {
  prInactivityDays: 30,
  instructions: '',
  provider: 'claude',
  model: DEFAULT_CLAUDE_MODEL,
  thinking: true,
  smartImports: true,
  reviewSuggestions: true,
  enableTools: false,
  enableWebResearch: false,
  proactiveMode: false,
  autoBriefings: true,
  briefingDailyLimit: 10,
  watchedRepos: ['klang/engine'],
  codeTheme: 'github-light',
  codeFont: 'jetbrains-mono',
  claudePath: '',
  codexPath: '',
  notifications: false,
  diffLayout: 'unified',
  includeAllFiles: true,
  reviewSignature: false,
  firstRunSeen: true,
  theme: 'light',
  trayEnabled: false,
  maxPrsPerRepo: 10,
  parallelReview: true,
  analytics: false,
  proactiveReviewOverrides: true,
  proactiveProvider: 'claude',
  proactiveModel: DEFAULT_FAST_CLAUDE_MODEL,
  proactiveThinking: false,
  educationMode: true,
  claudeContext: false,
  guestMode: false,
};
const url = 'https://github.com/example/repository/pull/1';
const request = { url, path: 'src/queue.ts', baseSha: 'base', headSha: 'head' };
const api: Partial<typeof window.electronAPI> = {
  loadPreferences: () => Promise.resolve(structuredClone(prefs)),
  savePreferences: (value) => {
    prefs = structuredClone(value);
    return Promise.resolve();
  },
  askPrFile: () => Promise.resolve('The queue applies backpressure before dispatch.'),
  submitReview: () => Promise.resolve({ reviewUrl: url + '#review', droppedCommentCount: 0 }),
  loadReviewImages: (reviewId, path) =>
    Promise.resolve({
      before: { status: 'absent' },
      after: {
        status: 'ready',
        path,
        revision: reviewId,
        dataUrl:
          'data:image/svg+xml;base64,' +
          btoa(
            '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect width="300" height="100" fill="#284eaf"/></svg>'
          ),
      },
    }),
};
Object.defineProperty(window, 'electronAPI', { value: api, configurable: true });
function Fixture() {
  const [chat, setChat] = useState(true),
    [file, setFile] = useState('queue.ts');
  const [width, setWidth] = useState(270),
    [committed, setCommitted] = useState(270);
  const [dialog, setDialog] = useState(false),
    [imageRevision, setImageRevision] = useState('image-1');
  const [commentCount, setCommentCount] = useState(0);
  return (
    <main className="inspection-hardening-fixture" style={{ padding: 20, height: '100dvh', overflow: 'auto' }}>
      <nav style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Button onClick={() => setChat((v) => !v)}>Toggle file chat</Button>
        <Button onClick={() => setFile((v) => (v === 'queue.ts' ? 'worker.ts' : 'queue.ts'))}>Switch file</Button>
        <Button onClick={() => setDialog(true)}>Submit review</Button>
        <Button onClick={() => setImageRevision((v) => `image-${Number(v.split('-')[1]) + 1}`)}>
          Next image revision
        </Button>
      </nav>
      <div
        className="pr-changes"
        style={{ position: 'relative', display: 'flex', flexDirection: 'row', height: 420, marginBlock: 16 }}
      >
        <div style={{ width, flexShrink: 0, padding: 12 }}>
          <h1>PR inspection</h1>
          <p>Keyboard and interrupted resize gestures</p>
          <output id="resize-value">{width}</output>
          <output id="resize-committed">{committed}</output>
        </div>
        <ChangesFileResize width={width} onChange={setWidth} onCommit={setCommitted} />
        {chat && (
          <PrFileChat
            request={{ ...request, path: 'src/' + file }}
            preferences={prefs}
            selection=""
            onClose={() => setChat(false)}
          />
        )}
      </div>
      <ReviewImageDiff reviewId={imageRevision} filePath="assets/queue.svg" enabled />
      <ChangesCommentComposer
        draftKey="inspection-hardening"
        label="Comment on new line 12"
        onSave={() => {
          setCommentCount((v) => v + 1);
          return Promise.resolve();
        }}
        onCancel={() => {}}
      />
      <output id="comment-count">{commentCount}</output>
      <SubmitReviewDialog
        open={dialog}
        onOpenChange={setDialog}
        comments={[]}
        prUrl={url}
        headSha="head"
        isOwnPr={false}
        onSubmit={(event, body) =>
          window.electronAPI.submitReview({
            prUrl: url,
            headSha: 'head',
            baseSha: 'base',
            baseBranch: 'main',
            event,
            body,
            comments: [],
          })
        }
      />
    </main>
  );
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<Fixture />);
