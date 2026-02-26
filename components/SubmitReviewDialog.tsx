import { useState, useEffect } from 'react';
import { AlertTriangle, Check, ExternalLink, MessageSquare, ShieldCheck, ShieldX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { PendingReviewComment, ReviewEvent } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  comments: PendingReviewComment[];
  prUrl: string;
  headSha?: string;
  isOwnPr: boolean;
  onSubmit: (event: ReviewEvent, body: string) => Promise<{ reviewUrl: string; droppedCommentCount: number }>;
}

export function SubmitReviewDialog({ open, onOpenChange, comments, headSha, isOwnPr, onSubmit }: Props) {
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successUrl, setSuccessUrl] = useState<string | null>(null);
  const [droppedCount, setDroppedCount] = useState(0);
  const [submittedCount, setSubmittedCount] = useState(0);
  const [reviewSignature, setReviewSignature] = useState(true);

  useEffect(() => {
    if (!open) return;
    void window.electronAPI.loadPreferences().then((prefs) => {
      setReviewSignature(prefs.reviewSignature);
    });
  }, [open]);

  // Group comments by file for the summary
  const fileGroups = new Map<string, PendingReviewComment[]>();
  for (const c of comments) {
    const existing = fileGroups.get(c.filePath);
    if (existing) {
      existing.push(c);
    } else {
      fileGroups.set(c.filePath, [c]);
    }
  }

  async function handleSubmit(event: ReviewEvent) {
    setSubmitting(true);
    setError(null);
    try {
      setSubmittedCount(comments.length);
      const result = await onSubmit(event, body);
      setSuccessUrl(result.reviewUrl);
      setDroppedCount(result.droppedCommentCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit review');
    } finally {
      setSubmitting(false);
    }
  }

  function handleClose() {
    if (successUrl) {
      setSuccessUrl(null);
      setBody('');
    }
    onOpenChange(false);
  }

  // Success state
  if (successUrl) {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Check className="h-5 w-5 text-green-500" />
              Review submitted
            </DialogTitle>
            <DialogDescription>
              Your review with {submittedCount} comment{submittedCount !== 1 ? 's' : ''} has been posted.
            </DialogDescription>
          </DialogHeader>
          {droppedCount > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-yellow-800/50 bg-yellow-950/30 p-3 text-sm text-yellow-200">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-yellow-500" />
              <span>
                {droppedCount} comment{droppedCount !== 1 ? 's were' : ' was'} on lines outside the diff range and{' '}
                {droppedCount !== 1 ? 'were' : 'was'} included in the review body instead.
              </span>
            </div>
          )}
          <div className="flex justify-center">
            <a
              href={successUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 underline underline-offset-2"
            >
              View on GitHub <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <DialogFooter>
            <Button onClick={handleClose}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Submit review</DialogTitle>
          <DialogDescription>
            {comments.length} comment{comments.length !== 1 ? 's' : ''} across {fileGroups.size} file
            {fileGroups.size !== 1 ? 's' : ''}
          </DialogDescription>
        </DialogHeader>

        {!headSha && (
          <div className="flex items-start gap-2 rounded-md border border-yellow-800/50 bg-yellow-950/30 p-3 text-sm text-yellow-200">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-yellow-500" />
            <span>
              This review was loaded from history without a commit reference. Line comments may land on wrong lines if
              the PR has been updated.
            </span>
          </div>
        )}

        {/* Comment list */}
        {comments.length > 0 && (
          <div className="flex-1 overflow-y-auto space-y-3 min-h-0">
            {Array.from(fileGroups.entries()).map(([filePath, fileComments]) => (
              <details key={filePath} className="group" open>
                <summary className="cursor-pointer text-xs font-mono text-muted-foreground hover:text-foreground select-none flex items-center gap-1">
                  <span className="group-open:rotate-90 inline-block transition-transform">▶</span>
                  {filePath}
                  <span className="text-blue-400 ml-1">({fileComments.length})</span>
                </summary>
                <div className="mt-1 ml-3 space-y-1">
                  {fileComments.map((c) => (
                    <div key={c.id} className="text-xs border rounded p-2 bg-muted/20">
                      <div className="flex items-center gap-2 text-muted-foreground mb-1">
                        <span>Line {c.line}</span>
                        <code className="text-[10px] bg-muted/50 px-1 rounded truncate max-w-[200px]">
                          {c.codeSnippet}
                        </code>
                      </div>
                      <pre className="text-xs whitespace-pre-wrap break-words font-mono">{c.body}</pre>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        )}

        {/* Review body */}
        <div className="flex flex-col gap-2">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Review summary (optional)</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Overall feedback..."
              className="w-full min-h-[80px] bg-transparent text-sm resize-y border rounded p-2 focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={reviewSignature}
              onChange={(e) => {
                setReviewSignature(e.target.checked);
                void window.electronAPI
                  .loadPreferences()
                  .then((prefs) => window.electronAPI.savePreferences({ ...prefs, reviewSignature: e.target.checked }));
              }}
              className="rounded border"
            />
            <span className="text-xs text-muted-foreground">Add &ldquo;Reviewed using gnosis.to&rdquo; signature</span>
          </label>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter className="flex-col gap-2 sm:flex-col sm:gap-2">
          {isOwnPr && (
            <p className="text-xs text-muted-foreground text-center">
              You can't approve or request changes on your own PR.
            </p>
          )}
          <div className="flex flex-row justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleSubmit('COMMENT')}
              disabled={submitting || (comments.length === 0 && !body.trim())}
            >
              <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
              Comment
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-green-800 text-green-400 hover:bg-green-950/50"
              onClick={() => handleSubmit('APPROVE')}
              disabled={submitting || isOwnPr}
            >
              <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />
              Approve
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-red-800 text-red-400 hover:bg-red-950/50"
              onClick={() => handleSubmit('REQUEST_CHANGES')}
              disabled={submitting || isOwnPr || (comments.length === 0 && !body.trim())}
            >
              <ShieldX className="h-3.5 w-3.5 mr-1.5" />
              Request changes
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
