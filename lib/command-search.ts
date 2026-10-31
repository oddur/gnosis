import { focusStackPr } from './stack-workspace';
import type { QueueItem, WorkbenchQueue } from './workbench';
import { isDependabot, sourceForPath } from './workbench';
import type { ReviewGuide, ReviewHistoryEntry } from './types';
import type { GitHubReviewThreads } from './review-threads';

export type SearchDestination =
  | {
      kind: 'home';
      section?: 'all' | 'requested' | 'updated' | 'stacks' | 'saved' | 'starred' | 'muted';
      repo?: string;
      viewId?: string;
      settings?: string;
      onboarding?: 'setup' | 'tour';
      local?: boolean;
      subject?: QueueItem;
      url?: string;
    }
  | {
      kind: 'review';
      reviewId: string;
      slideId?: string;
      filePath?: string;
      line?: number;
      side?: 'LEFT' | 'RIGHT';
      threadId?: string;
      explore?: boolean;
    }
  | { kind: 'activity' };
export interface SearchDocument {
  id: string;
  kind: 'pr' | 'stack' | 'briefing' | 'topic' | 'file' | 'insight' | 'comment' | 'explainer' | 'view' | 'repository';
  title: string;
  text: string;
  preview?: string;
  code?: string;
  groupId: string;
  groupTitle: string;
  source: string;
  sourceUrl?: string;
  author?: string;
  state?: string;
  bot?: boolean;
  botHidden?: boolean;
  destination: SearchDestination;
  reviewId?: string;
}
export interface SearchSnapshot {
  account: string;
  documents: SearchDocument[];
  queue: WorkbenchQueue;
  ignoreBots: boolean;
  warnings: string[];
}
export interface SearchHit {
  document: SearchDocument;
  score: number;
  snippet: string;
  proseSnippet?: string;
  codeSnippet?: string;
}
export function searchableText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function snippet(text: string, query: string): string {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const index =
    terms
      .map((t) => text.toLowerCase().indexOf(t))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, index - 65);
  return (start ? '…' : '') + text.slice(start, start + 210) + (text.length > start + 210 ? '…' : '');
}
export function searchHit(document: SearchDocument, query = '', score = 0): SearchHit {
  let codeSnippet: string | undefined;
  if (document.code) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const match =
      terms
        .map((term) => (document.code ?? '').toLowerCase().indexOf(term))
        .filter((index) => index >= 0)
        .sort((a, b) => a - b)[0] ?? 0;
    const start = document.code.lastIndexOf('\n', Math.max(0, match - 80)) + 1;
    const lines = document.code.slice(start).split('\n');
    codeSnippet = (start ? '…\n' : '') + lines.slice(0, 8).join('\n').slice(0, 1200) + (lines.length > 8 ? '\n…' : '');
  }
  return {
    document,
    score,
    snippet: snippet(query ? document.text : (document.preview ?? document.text), query),
    codeSnippet,
    proseSnippet: document.code && document.preview ? snippet(document.preview, query) : undefined,
  };
}
function fuzzy(query: string, text: string): boolean {
  if (query.length < 3 || query.length > 40) return false;
  let i = 0;
  for (const c of text) if (c === query[i]) i++;
  return i === query.length;
}
export function searchDocuments(documents: SearchDocument[], query: string, includeBots = false): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  return documents
    .flatMap((document) => {
      if (document.bot && document.botHidden !== false && !includeBots) return [];
      const title = document.title.toLowerCase(),
        source = document.source.toLowerCase();
      const text =
        `${title} ${source} ${source.replace(/ #/g, '#')} ${document.author ?? ''} ${document.text}`.toLowerCase();
      const exact =
        title === q ||
        (/^(?:#\d+|[^\s]+\/[^\s]+#\d+)$/.test(q) &&
          (source.split(/[\s·]+/).includes(q) || source.replace(/ #/g, '#').split(' · ').includes(q)));
      const all = terms.every((t) => text.includes(t));
      if (!all && !fuzzy(q, title)) return [];
      const score = exact
        ? 1000
        : title.startsWith(q)
          ? 800
          : title.includes(q)
            ? 650
            : terms.every((t) => `${title} ${source}`.includes(t))
              ? 500
              : all
                ? 300
                : 100;
      return [searchHit(document, q, score + (['pr', 'stack'].includes(document.kind) ? 20 : 0))];
    })
    .sort((a, b) => b.score - a.score || a.document.title.localeCompare(b.document.title));
}
export function queueDocuments(queue: WorkbenchQueue): SearchDocument[] {
  const docs: SearchDocument[] = [];
  const items: QueueItem[] = [...queue.items, ...(queue.starredItems ?? [])];
  for (const subject of queue.stacks ?? []) if (!items.some(item => item.subject.id === subject.id))
    items.push({ subject, attention: 'other' });
  for (const item of new Map(items.map(item => [item.subject.id, item])).values()) {
    const s = item.subject;
    const source = s.members.map((m) => `${m.repo} #${m.number}`).join(' · ');
    const common = {
      sourceUrl: s.members.length === 1 ? s.members[0].url : undefined,
      groupId: s.id,
      groupTitle: s.title,
      source,
      author: s.members.map((m) => m.author).join(' '),
      bot: s.members.every((m) => isDependabot(m.author)),
      state: s.members.every((m) => m.merged)
        ? 'Merged'
        : s.members.every((m) => m.state === 'closed')
          ? 'Closed'
          : s.members.some((m) => m.isDraft)
            ? 'Draft'
            : 'Open',
      reviewId: item.review?.status === 'failed' || item.review?.status === 'generating' ? undefined : item.review?.id,
    };
    docs.push({
      ...common,
      id: `subject:${s.id}`,
      kind: s.kind,
      title: s.title,
      preview:
        item.briefing?.summary ||
        [...new Set(s.members.map(m=>m.description.replace(/\s+/g,' ').trim()).filter(Boolean))].join('\n\n'),
      text: s.members
        .map((m) => `${m.title}\n${m.description}\n${m.labels.join(' ')} ${m.baseBranch} ${m.headBranch}`)
        .join('\n'),
      destination: { kind: 'home', subject: item },
    });
    if (s.kind === 'stack') for (const member of s.members) docs.push({
      ...common, id: `subject:${member.url}`, kind: 'pr', title: member.title,
      source: `${member.repo} #${member.number}`, sourceUrl: member.url,
      author: member.author, bot: isDependabot(member.author),
      state: member.merged ? 'Merged' : member.state === 'closed' ? 'Closed' : member.isDraft ? 'Draft' : 'Open',
      reviewId: undefined,
      preview: member.description, text: `${member.description} ${member.labels.join(' ')} ${member.baseBranch} ${member.headBranch}`,
      destination: { kind: 'home', subject: focusStackPr(item, member) },
    });
    if (item.briefing?.summary)
      docs.push({
        ...common,
        id: `briefing:${s.id}`,
        kind: 'briefing',
        title: `Briefing · ${s.title}`,
        text: item.briefing.summary,
        destination: { kind: 'home', subject: item },
      });
  }
  for (const view of queue.savedViews?.views ?? [])
    docs.push({
      id: `view:${view.id}`,
      kind: 'view',
      title: view.name,
      text: 'Saved queue view',
      groupId: `view:${view.id}`,
      groupTitle: view.name,
      source: 'Saved view',
      destination: { kind: 'home', viewId: view.id },
    });
  for (const repo of new Set(queue.items.flatMap((i) => i.subject.members.map((m) => m.repo))))
    docs.push({
      id: `repo:${repo}`,
      kind: 'repository',
      title: repo,
      text: 'Show this repository in the review queue',
      groupId: `repo:${repo}`,
      groupTitle: repo,
      source: 'Repository',
      destination: { kind: 'home', repo },
    });
  return docs;
}
export function reviewDocuments(
  review: ReviewGuide,
  entry: ReviewHistoryEntry,
  queue: WorkbenchQueue
): SearchDocument[] {
  const queued = queue.items.find(
    (i) => i.subject.id === review.snapshot?.subject.id || i.subject.members.some((m) => m.url === entry.prUrl)
  );
  const subject = queued?.subject ?? review.snapshot?.subject;
  const groupId = subject?.id ?? entry.prUrl;
  const common = {
    groupId,
    sourceUrl: subject?.kind === 'stack' ? undefined : entry.prUrl,
    groupTitle: subject?.title ?? entry.prTitle,
    source: subject?.members.map((m) => `${m.repo} #${m.number}`).join(' · ') ?? entry.prUrl,
    author: entry.author,
    bot: subject ? subject.members.every((m) => isDependabot(m.author)) : isDependabot(entry.author),
    state: entry.prState === 'merged' ? 'Merged' : entry.prState === 'closed' ? 'Closed' : 'Saved review',
    reviewId: entry.id,
  };
  const docs: SearchDocument[] = [];
  if (!queued)
    docs.push({
      ...common,
      id: `review:${entry.id}`,
      kind: subject?.kind ?? 'pr',
      title: entry.prTitle,
      text: `${review.prDescription}\n${review.summary}`,
      destination: subject
        ? { kind: 'home', subject: { subject, review: entry, attention: 'other' } }
        : { kind: 'review', reviewId: entry.id, slideId: 'overview' },
    });
  docs.push({
    ...common,
    id: `summary:${entry.id}`,
    kind: 'topic',
    title: `Overview · ${entry.prTitle}`,
    text: `${review.summary}\n${review.riskRationale}`,
    destination: { kind: 'review', reviewId: entry.id, slideId: 'overview' },
  });
  for (const slide of review.slides) {
    const destination: SearchDestination = { kind: 'review', reviewId: entry.id, slideId: slide.id };
    docs.push({
      ...common,
      id: `topic:${entry.id}:${slide.id}`,
      kind: 'topic',
      title: slide.title,
      text: [
        slide.narrative,
        slide.reviewFocus,
        ...slide.contextSnippets,
        ...(slide.educationNotes ?? []).map((n) => JSON.stringify(n)),
        ...(slide.reviewChecks ?? []).map((n) => JSON.stringify(n)),
      ]
        .filter(Boolean)
        .join('\n'),
      destination,
    });
    for (const filePath of new Set([...slide.affectedFiles, ...slide.diffHunks.map((h) => h.filePath)])) {
      const member = sourceForPath(review, filePath).member;
      docs.push({
        ...common,
        source: member ? `${member.repo} #${member.number}` : common.source,
        sourceUrl: member?.url ?? (subject?.kind !== 'stack' ? entry.prUrl : undefined),
        id: `file:${entry.id}:${slide.id}:${filePath}`,
        kind: 'file',
        title: sourceForPath(review, filePath).path,
        preview: (slide.fileSummaries ?? [])
          .filter((f) => f.filePath === filePath)
          .map((f) => f.summary)
          .join('\n'),
        code: slide.diffHunks
          .filter((h) => h.filePath === filePath)
          .map((h) => h.content)
          .join('\n'),
        text: [
          ...(slide.fileSummaries ?? []).filter((f) => f.filePath === filePath).map((f) => f.summary),
          ...slide.diffHunks.filter((h) => h.filePath === filePath).map((h) => h.content),
        ].join('\n'),
        destination: { ...destination, filePath },
      });
    }
    for (const [index, insight] of (slide.inlineExplanations ?? []).entries()) {
      const member = sourceForPath(review, insight.filePath).member;
      docs.push({
        ...common,
        source: member ? `${member.repo} #${member.number}` : common.source,
        sourceUrl: member?.url,
        id: `insight:${entry.id}:${slide.id}:${index}`,
        kind: 'insight',
        title: `${sourceForPath(review, insight.filePath).path}:${insight.line}`,
        text: insight.text,
        destination: { ...destination, filePath: insight.filePath, line: insight.line, side: insight.side },
      });
    }
    if (slide.explainer)
      docs.push({
        ...common,
        id: `explainer:${entry.id}:${slide.id}`,
        kind: 'explainer',
        title: slide.explainer.title,
        text: slide.explainer.description,
        destination: { ...destination, explore: true },
      });
  }
  return docs;
}
export function threadDocuments(
  url: string,
  threads: GitHubReviewThreads,
  documents: SearchDocument[]
): SearchDocument[] {
  const parent = documents.find((d) => d.kind === 'pr' || d.kind === 'stack');
  if (!parent) return [];
  return threads.threads.flatMap((thread) =>
    thread.comments.map((comment) => {
      const file = documents.find(
        (d) =>
          d.kind === 'file' &&
          (d.sourceUrl === url || (!d.sourceUrl && parent.kind !== 'stack')) &&
          (d.title === thread.path || d.title.endsWith('/' + thread.path))
      );
      const destination =
        file?.destination.kind === 'review'
          ? { ...file.destination, line: thread.line ?? undefined, side: thread.diffSide, threadId: thread.id }
          : parent.destination;
      return {
        ...parent,
        id: `comment:${comment.id}`,
        kind: 'comment' as const,
        title: `${thread.path} · ${comment.author?.login ?? 'GitHub comment'}`,
        text: comment.body,
        author: comment.author?.login,
        source: file?.source ?? url,
        sourceUrl: url,
        destination,
      };
    })
  );
}
