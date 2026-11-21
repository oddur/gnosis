import { createContext, useContext } from 'react';
import { FileCode2, Globe, SquareArrowOutUpRight } from 'lucide-react';
import {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationQuote,
  InlineCitationSource,
} from './ai-elements/inline-citation';
import { citationFromIsland, resolveChatCitation, type ResolvedCitation } from '../lib/chat-citations';

/** Where a chat's citations point: the PR's files, the lines a card previews, and how a click opens them. */
export interface ChatCitationSource {
  /** Repository-relative paths of the files in the PR. A citation of any other file renders as plain text. */
  files: readonly string[];
  /** The cited lines, when the chat has them (a topic's hunks). */
  preview?: (path: string, startLine: number, endLine: number) => string | undefined;
  /** Opens the cited file and lines in Changes. Without it, a file citation is a label with a card. */
  open?: (target: { path: string; startLine?: number; endLine?: number }) => void;
}

export const ChatCitationContext = createContext<ChatCitationSource | undefined>(undefined);

const PREVIEW_LINES = 12;

function linesText(c: Extract<ResolvedCitation, { kind: 'file' }>) {
  if (!c.startLine) return 'Whole file';
  return c.endLine && c.endLine !== c.startLine ? `Lines ${c.startLine}–${c.endLine}` : `Line ${c.startLine}`;
}

/** One citation in an answer: an inline citation for a PR file or a page, plain text for anything else. */
export function ChatCitation({ data }: { data: Readonly<Record<string, unknown>> }) {
  const source = useContext(ChatCitationContext);
  const citation = resolveChatCitation(citationFromIsland(data), source?.files ?? []);
  const raw = typeof data.raw === 'string' && data.raw ? data.raw : typeof data.label === 'string' ? data.label : '';
  // Unresolved: the model's own words, as it wrote them. Nothing links to a file the PR does not have.
  if (!citation)
    return (
      <span className="chat-citation-unresolved" data-citation-unresolved="">
        [{raw}]
      </span>
    );
  if (citation.kind === 'url')
    return (
      <InlineCitation>
        <InlineCitationCard>
          <InlineCitationCardTrigger
            aria-label={`Source: ${citation.host}, opens in the browser`}
            data-citation-url={citation.url}
            onClick={() => window.open(citation.url, '_blank', 'noopener,noreferrer')}
          >
            <Globe aria-hidden="true" />
            {citation.label}
          </InlineCitationCardTrigger>
          <InlineCitationCardBody>
            <InlineCitationSource
              icon={<Globe aria-hidden="true" />}
              title={citation.host}
              detail={<span className="inline-citation-url">{citation.url}</span>}
            />
          </InlineCitationCardBody>
        </InlineCitationCard>
      </InlineCitation>
    );
  const open = source?.open;
  const preview =
    citation.startLine && citation.endLine
      ? source?.preview?.(
          citation.path,
          citation.startLine,
          Math.min(citation.endLine, citation.startLine + PREVIEW_LINES - 1)
        )
      : undefined;
  const target = { path: citation.path, startLine: citation.startLine, endLine: citation.endLine };
  const where = linesText(citation);
  return (
    <InlineCitation>
      <InlineCitationCard>
        <InlineCitationCardTrigger
          aria-label={`${citation.path}, ${where.toLowerCase()}${open ? '. Open in Changes' : ''}`}
          data-citation-path={citation.path}
          data-citation-lines={citation.startLine ? `${citation.startLine}-${citation.endLine}` : undefined}
          onClick={open ? () => open(target) : undefined}
        >
          {citation.label}
        </InlineCitationCardTrigger>
        <InlineCitationCardBody>
          <InlineCitationSource
            icon={<FileCode2 aria-hidden="true" />}
            title={<span className="inline-citation-path">{citation.path}</span>}
            detail={where}
          />
          {preview !== undefined && (
            <InlineCitationQuote>
              {preview}
              {citation.endLine && citation.startLine && citation.endLine - citation.startLine >= PREVIEW_LINES
                ? '\n…'
                : ''}
            </InlineCitationQuote>
          )}
          {open && (
            <button type="button" className="inline-citation-open" onClick={() => open(target)}>
              <SquareArrowOutUpRight size={12} aria-hidden="true" />
              Open in Changes
            </button>
          )}
        </InlineCitationCardBody>
      </InlineCitationCard>
    </InlineCitation>
  );
}
