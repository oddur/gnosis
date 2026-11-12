import { focusStackPr } from './stack-workspace';
import type { QueueItem, WorkbenchQueue } from './workbench';
import { isDependabot, sourceForPath } from './workbench';
import type { ReviewGuide, ReviewHistoryEntry } from './types';
import type { GitHubReviewThreads } from './review-threads';

export type SearchDestination =
  | {
      kind: 'home';
      section?: 'response' | 'all' | 'requested' | 'updated' | 'stacks' | 'saved' | 'starred' | 'muted';
      repo?: string;
      viewId?: string;
      settings?: string;
      onboarding?: 'setup' | 'tour';
      /** Opens the GitHub account dialog. */
      account?: boolean;
      local?: boolean;
      subject?: QueueItem;
      url?: string;
      /** Stored form: main replaces this with the current queue subject before a hit is returned. */
      subjectId?: string;
      /** Stored form: the stack member to focus once `subjectId` is resolved. */
      focusUrl?: string;
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
  /** Every PR this document belongs to, so a mute of any of them hides it. Index only. */
  memberUrls?: string[];
  /** For GitHub comments: the thread, so the index can link the comment to a saved review file. */
  thread?: { path: string; line?: number; side?: 'LEFT' | 'RIGHT'; id: string };
}
export const SEARCH_TITLE_CHARS = 300;
export const SEARCH_TEXT_CHARS = 600;
export const SEARCH_PREVIEW_CHARS = 300;
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  // Do not leave half of a surrogate pair at the end.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}
/**
 * The index keeps bounded metadata and a snippet, never diffs or full descriptions. Every document
 * builder returns its documents through this, so the index size depends on the document count only.
 */
export function boundDocument(document: SearchDocument): SearchDocument {
  const bounded: SearchDocument = {
    ...document,
    title: clip(document.title, SEARCH_TITLE_CHARS),
    text: clip(document.text.replace(/\s+/g, ' ').trim(), SEARCH_TEXT_CHARS),
  };
  delete bounded.code;
  if (document.preview !== undefined) bounded.preview = clip(document.preview, SEARCH_PREVIEW_CHARS);
  else delete bounded.preview;
  return bounded;
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
/** Queue entries that search can open, by subject id: the queue, starred work and retained stacks. */
export function queueSubjects(queue: WorkbenchQueue): Map<string, QueueItem> {
  const items: QueueItem[] = [...queue.items, ...(queue.starredItems ?? [])];
  for (const subject of queue.stacks ?? [])
    if (!items.some((item) => item.subject.id === subject.id)) items.push({ subject, attention: 'other' });
  return new Map(items.map((item) => [item.subject.id, item]));
}
const memberLine = (m: QueueItem['subject']['members'][number]) =>
  `${m.title} ${m.repo} #${m.number} ${m.author} ${m.labels.join(' ')} ${m.baseBranch} ${m.headBranch}`;
/** One queue subject. Labels and branches come before descriptions, so the bounded snippet keeps them. */
export function subjectDocuments(item: QueueItem): SearchDocument[] {
  const docs: SearchDocument[] = [];
  const s = item.subject;
  const source = s.members.map((m) => `${m.repo} #${m.number}`).join(' · ');
  const descriptions = [...new Set(s.members.map((m) => m.description.replace(/\s+/g, ' ').trim()).filter(Boolean))];
  const common = {
    sourceUrl: s.members.length === 1 ? s.members[0].url : undefined,
    memberUrls: s.members.map((m) => m.url),
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
    preview: item.briefing?.summary || descriptions.join('\n\n'),
    text: [...s.members.map(memberLine), ...descriptions].join('\n'),
    destination: { kind: 'home', subjectId: s.id },
  });
  if (s.kind === 'stack')
    for (const member of s.members)
      docs.push({
        ...common,
        id: `subject:${member.url}`,
        kind: 'pr',
        title: member.title,
        source: `${member.repo} #${member.number}`,
        sourceUrl: member.url,
        author: member.author,
        bot: isDependabot(member.author),
        state: member.merged ? 'Merged' : member.state === 'closed' ? 'Closed' : member.isDraft ? 'Draft' : 'Open',
        reviewId: undefined,
        preview: member.description,
        text: `${member.labels.join(' ')} ${member.baseBranch} ${member.headBranch}\n${member.description}`,
        destination: { kind: 'home', subjectId: s.id, focusUrl: member.url },
      });
  if (item.briefing?.summary)
    docs.push({
      ...common,
      id: `briefing:${s.id}`,
      kind: 'briefing',
      title: `Briefing · ${s.title}`,
      text: item.briefing.summary,
      destination: { kind: 'home', subjectId: s.id },
    });
  return docs.map(boundDocument);
}
/** Saved views and repositories: everything in the queue that is not a subject. */
export function queueMetaDocuments(queue: WorkbenchQueue): SearchDocument[] {
  const docs: SearchDocument[] = [];
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
  return docs.map(boundDocument);
}
export function queueDocuments(queue: WorkbenchQueue): SearchDocument[] {
  return [...[...queueSubjects(queue).values()].flatMap(subjectDocuments), ...queueMetaDocuments(queue)];
}
/**
 * Replace a stored `subjectId` with the current queue entry, focused on a stack member when the
 * document names one. A subject that has left the queue opens its PR by URL instead.
 */
export function hydrateDestination(
  document: SearchDocument,
  find: (subjectId: string) => QueueItem | undefined
): SearchDestination {
  const destination = document.destination;
  if (destination.kind !== 'home' || !destination.subjectId) return destination;
  const { subjectId, focusUrl, ...rest } = destination;
  const item = find(subjectId);
  const member = focusUrl ? item?.subject.members.find((m) => m.url === focusUrl) : undefined;
  if (item && !focusUrl) return { ...rest, subject: item };
  if (item && member) return { ...rest, subject: item.subject.kind === 'stack' ? focusStackPr(item, member) : item };
  const url = focusUrl ?? rest.url ?? document.sourceUrl ?? document.memberUrls?.[0];
  return url ? { kind: 'home', url } : { kind: 'home' };
}
/**
 * Saved review documents. With a queue, a queued PR keeps the queue's group and skips its own PR
 * document. Without one (the index worker), the index hides that document at query time instead.
 */
export function reviewDocuments(
  review: ReviewGuide,
  entry: Pick<ReviewHistoryEntry, 'id' | 'prUrl' | 'prTitle' | 'author' | 'prState'>,
  queue?: WorkbenchQueue
): SearchDocument[] {
  const queued = queue?.items.find(
    (i) => i.subject.id === review.snapshot?.subject.id || i.subject.members.some((m) => m.url === entry.prUrl)
  );
  const subject = queued?.subject ?? review.snapshot?.subject;
  const groupId = subject?.id ?? entry.prUrl;
  const common = {
    groupId,
    sourceUrl: subject?.kind === 'stack' ? undefined : entry.prUrl,
    memberUrls: [...new Set([entry.prUrl, ...(review.snapshot?.subject.members.map((m) => m.url) ?? [])])],
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
        ? { kind: 'home', subjectId: subject.id, url: entry.prUrl }
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
      const { member, path } = sourceForPath(review, filePath);
      const summaries = (slide.fileSummaries ?? []).filter((f) => f.filePath === filePath).map((f) => f.summary);
      // Paths and summaries only: diff hunks are not searchable.
      docs.push({
        ...common,
        source: member ? `${member.repo} #${member.number}` : common.source,
        sourceUrl: member?.url ?? (subject?.kind !== 'stack' ? entry.prUrl : undefined),
        id: `file:${entry.id}:${slide.id}:${filePath}`,
        kind: 'file',
        title: path,
        preview: summaries.join('\n'),
        text: [path, ...summaries].join('\n'),
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
  return docs.map(boundDocument);
}
/** The saved review file a GitHub comment's thread belongs to, if `documents` holds one. */
export function threadFile(url: string, path: string, documents: readonly SearchDocument[], stack = false) {
  return documents.find(
    (d) =>
      d.kind === 'file' &&
      (d.sourceUrl === url || (!d.sourceUrl && !stack)) &&
      (d.title === path || d.title.endsWith('/' + path))
  );
}
export function threadDocuments(
  url: string,
  threads: GitHubReviewThreads,
  documents: SearchDocument[]
): SearchDocument[] {
  const parent = documents.find((d) => d.kind === 'pr' || d.kind === 'stack');
  if (!parent) return [];
  return threads.threads
    .flatMap((thread) =>
      thread.comments.map((comment): SearchDocument => {
        const file = threadFile(url, thread.path, documents, parent.kind === 'stack');
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
          preview: undefined,
          author: comment.author?.login,
          source: file?.source ?? url,
          sourceUrl: url,
          destination,
          thread: { path: thread.path, line: thread.line ?? undefined, side: thread.diffSide, id: thread.id },
        };
      })
    )
    .map(boundDocument);
}
