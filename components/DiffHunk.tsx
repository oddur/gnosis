import { useMemo } from 'react';
import { parseDiffLines } from '@/lib/diff-lines';
import { FilePathLink } from '@/components/FilePathLink';
import {
  parseShikiLines,
  extractShikiStyles,
  lineAnchorAttrs,
} from '@/components/shared-diff-utils';
import type { DiffHunk as DiffHunkType } from '@/lib/types';

interface Props {
  hunk: DiffHunkType;
  showFileHeader?: boolean;
  gitFileUrlBase?: string | null;
}

export function DiffHunk({ hunk, showFileHeader = true, gitFileUrlBase }: Props) {
  return (
    <div className="rounded-md border overflow-x-auto">
      {showFileHeader && (
        <div className="bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground border-b truncate">
          <FilePathLink filePath={hunk.filePath} gitFileUrlBase={gitFileUrlBase} />
        </div>
      )}
      {hunk.hunkHeader && (
        <div className="bg-muted/30 px-3 py-1 font-mono text-xs text-muted-foreground border-b">{hunk.hunkHeader}</div>
      )}
      <PlainHunk hunk={hunk} filePath={hunk.filePath} />
    </div>
  );
}

interface GroupedProps {
  filePath: string;
  hunks: DiffHunkType[];
  gitFileUrlBase?: string | null;
}

export function DiffHunkGroup({ filePath, hunks, gitFileUrlBase }: GroupedProps) {
  return (
    <div className="rounded-md border overflow-x-auto">
      <div className="bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground border-b truncate">
        <FilePathLink filePath={filePath} gitFileUrlBase={gitFileUrlBase} />
      </div>
      {hunks.map((hunk, i) => (
        <div key={i}>
          {i > 0 && <div className="border-t border-dashed border-muted" />}
          {hunk.hunkHeader && (
            <div className="bg-muted/30 px-3 py-1 font-mono text-xs text-muted-foreground border-b">
              {hunk.hunkHeader}
            </div>
          )}
          <PlainHunk hunk={hunk} filePath={filePath} />
        </div>
      ))}
    </div>
  );
}

// Non-interactive unified hunk. Same per-line structure as
// InteractiveDiffHunk so review-check anchoring (data-file-path +
// data-line-number / data-base-line) works in read-only mode too.
// Falls back to raw innerHTML if the Shiki HTML can't be parsed line
// by line (extremely rare — defensive only).
function PlainHunk({ hunk, filePath }: { hunk: DiffHunkType; filePath: string }) {
  const lineInfos = useMemo(() => parseDiffLines(hunk.hunkHeader, hunk.content), [hunk.hunkHeader, hunk.content]);
  const lineHtmls = useMemo(() => parseShikiLines(hunk.renderedHtml), [hunk.renderedHtml]);
  const shikiStyles = useMemo(() => extractShikiStyles(hunk.renderedHtml), [hunk.renderedHtml]);

  if (!lineHtmls || lineInfos.length === 0 || lineHtmls.length < lineInfos.length) {
    return <div className="select-text" dangerouslySetInnerHTML={{ __html: hunk.renderedHtml }} />;
  }

  const hasDiff = lineInfos.some((l) => l.type !== 'context');

  return (
    <pre className={`${shikiStyles.preClass} select-text`} style={shikiStyles.preStyle}>
      <code style={{ display: 'block', fontSize: 0, minWidth: '100%', width: 'max-content' }}>
        {lineInfos.map((info, idx) => {
          const diffClass = info.type === 'add' ? 'diff add' : info.type === 'remove' ? 'diff remove' : '';
          return (
            <span
              key={idx}
              className={`line ${diffClass}`}
              {...lineAnchorAttrs(filePath, info)}
              style={{
                display: 'flex',
                alignItems: 'center',
                fontSize: '0.8125rem',
                lineHeight: '1.5',
                paddingRight: '1.25rem',
              }}
            >
              <span
                className="line-number-gutter"
                style={{
                  display: 'inline-block',
                  width: '3.5ch',
                  textAlign: 'right',
                  paddingRight: '0.5ch',
                  color: 'var(--muted-foreground)',
                  userSelect: 'none',
                  flexShrink: 0,
                  fontSize: '0.75rem',
                }}
              >
                {info.lineNumber}
              </span>
              {hasDiff && (
                <span
                  style={{
                    display: 'inline-block',
                    width: '1ch',
                    marginRight: '1ch',
                    userSelect: 'none',
                    flexShrink: 0,
                    color:
                      info.type === 'add' ? '#3fb950' : info.type === 'remove' ? '#f85149' : 'transparent',
                  }}
                >
                  {info.type === 'add' ? '+' : info.type === 'remove' ? '-' : ' '}
                </span>
              )}
              <span dangerouslySetInnerHTML={{ __html: lineHtmls[idx] }} style={{ flex: 1, minWidth: 0 }} />
            </span>
          );
        })}
      </code>
    </pre>
  );
}
