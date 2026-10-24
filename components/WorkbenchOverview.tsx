import { GitHubAuthor } from './GitHubAuthor';
import { sourceForPath } from '../lib/workbench';
import { useState } from 'react';
import { PrSubjectDetails } from './PrSubjectDetails';
import { ArrowRight, GitPullRequest, Layers, Check, ExternalLink } from 'lucide-react';
import { Markdown } from './Markdown';
import { Button } from './ui/button';
import type { ReviewGuide } from '../lib/types';
export function WorkbenchOverview({
  review,
  embedded = false,
  reviewed,
  onNavigate,
  onSubmit,
  submissions = {},
}: {
  review: ReviewGuide;
  embedded?: boolean;
  reviewed: Set<number>;
  onNavigate: (n: number) => void;
  onSubmit: (url: string) => void;
  submissions?: Record<string, string>;
}) {
  const subject = review.snapshot?.subject;
  const [showDetails, setShowDetails] = useState(false);
  const [memberUrl, setMemberUrl] = useState(subject?.members[0].url ?? '');
  const legacyRepo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//.exec(review.prUrl)?.[1];
  return (
    <div className="workbench-overview">
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
        {subject?.kind === 'stack' ? (
          <>
            <Layers size={15} />
            {subject.members.length} PRs · one review
          </>
        ) : (
          <>
            <GitPullRequest size={15} />
            Change overview
          </>
        )}
        <span className="ml-auto">
          {reviewed.size}/{review.slides.length} topics reviewed
        </span>
      </div>
      {!embedded && <h1>{review.prTitle}</h1>}
      {!embedded && (subject || review.prDescription) && (
        <div className="pr-overview-switch" aria-label="Overview content">
          <button aria-pressed={!showDetails} onClick={() => setShowDetails(false)}>
            AI explanation
          </button>
          <button aria-pressed={showDetails} onClick={() => setShowDetails(true)}>
            Author description
          </button>
        </div>
      )}
      {showDetails ? (
        <>
          <p className="text-xs text-muted-foreground mt-3">GitHub information saved with this review.</p>
          {subject ? (
            <PrSubjectDetails subject={subject} activeUrl={memberUrl} onSelect={setMemberUrl} />
          ) : (
            <Markdown
              className="pr-markdown mt-4"
              headingLevel={2}
              githubSource={legacyRepo ? { repo: legacyRepo, ref: review.headSha ?? 'HEAD' } : undefined}
            >
              {review.prDescription || 'No description provided.'}
            </Markdown>
          )}
        </>
      ) : (
        <>
          <Markdown className="overview-summary">{review.summary}</Markdown>
          <div className="flex items-center gap-3 mt-5">
            <Button
              size="sm"
              onClick={() => onNavigate(review.slides.find((s) => !reviewed.has(s.slideNumber))?.slideNumber ?? 1)}
            >
              Continue review <ArrowRight size={14} />
            </Button>
            <span className="text-xs text-muted-foreground">
              {review.totalFilesChanged} file changes · {review.totalLinesChanged} lines
            </span>
          </div>
          <div className="overview-columns">
            <section>
              <h2>Review path</h2>
              {review.slides.map((s) => (
                <button className="overview-topic" key={s.id} onClick={() => onNavigate(s.slideNumber)}>
                  <span className="stack-step">
                    {reviewed.has(s.slideNumber) ? <Check size={13} /> : s.slideNumber}
                  </span>
                  <span className="flex-1">{s.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {s.diffHunks.length} changed code {s.diffHunks.length === 1 ? 'block' : 'blocks'}
                  </span>
                  <ArrowRight size={14} />
                </button>
              ))}
            </section>
            <aside>
              <h2>Where to focus</h2>
              <Markdown className="text-sm leading-relaxed">{review.riskRationale}</Markdown>
              <h2>{subject?.kind === 'stack' ? 'PRs in this stack' : 'GitHub feedback'}</h2>
              {subject ? (
                subject.members.map((m, i) => {
                  const topics = review.slides.filter((s) =>
                    s.diffHunks.some((h) => sourceForPath(review, h.filePath).member?.url === m.url)
                  );
                  const done = topics.filter((s) => reviewed.has(s.slideNumber)).length;
                  return (
                    <div className="overview-member" key={m.url}>
                      <div className="flex items-start gap-2">
                        <span className="stack-step">{i + 1}</span>
                        <span className="text-sm font-medium">
                          #{m.number} {m.title}
                        </span>
                      </div>
                      <p>
                        {m.repo} · <GitHubAuthor login={m.author} /> · {m.merged ? 'Merged' : m.state}
                      </p>
                      <p>
                        {done}/{topics.length} topics reviewed{submissions[m.url] ? ` · ${submissions[m.url]}` : ''}
                      </p>
                      <div className="flex gap-3 mt-2 text-xs">
                        <button
                          className="text-[var(--ring)]"
                          onClick={() => onSubmit(m.url)}
                          disabled={m.merged || m.state === 'closed'}
                        >
                          Submit to GitHub
                        </button>
                        <button
                          className="inline-flex items-center gap-1 text-muted-foreground"
                          onClick={() => void window.electronAPI.openExternal(m.url)}
                        >
                          GitHub <ExternalLink size={11} />
                        </button>
                      </div>
                    </div>
                  );
                })
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onSubmit(review.prUrl)}
                  disabled={review.prUrl.startsWith('local:')}
                >
                  Submit to GitHub
                </Button>
              )}
              {subject?.warnings.map((w) => (
                <p className="workbench-notice mt-3" key={w}>
                  {w}
                </p>
              ))}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
