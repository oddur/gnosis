import { memo, useEffect, useLayoutEffect, useMemo, useState, type MouseEvent } from 'react';
import { Markdown as Words, type PluginConfig, type ReactiveIslands } from '@pierre/words/react';
import { createHighlightsPlugin } from '@pierre/words/highlights';
import { themes as highlightsThemes } from '@pierre/highlights/themes/loader';
import { CODE_THEMES } from '../lib/constants';
import { applyCodePalette } from '../lib/diff-code-palette';
import { diffThemeName } from '../lib/diff-worker-pool';
import { readableHighlightsTheme } from '../lib/highlights-theme';
import { useReaderCodeTheme } from '../lib/reader-code-theme';
import { useDiffAppearance } from '../lib/use-diff-appearance';
import { CHAT_DIFF_ISLAND, parseChatDiff, withDiffIslands } from '../lib/chat-diffs';
import { countRender } from '../lib/render-count';
import { startupPreferences } from '../lib/startup-preferences';
import { cn } from '../lib/utils';
import { DiffFileHeader } from './DiffFileHeader';
import { ReviewDiff } from './ReviewDiff';

/**
 * Chat messages, rendered by Words (@pierre/words) as they stream: new text fades in, a caret marks where it lands,
 * unfinished emphasis, links and code read as finished, and completed blocks are not parsed again. Code is
 * highlighted as it streams by Highlights, the engine the diffs use, in the reader's code theme with the same contrast
 * floor (lib/highlights-theme.ts), and carries Copy and Download. A closed ```diff fence shows as a diff, rendered as
 * Changes renders one (lib/chat-diffs.ts, ReviewDiff).
 */

/**
 * Links open in the browser, through the main window's open handler, as a `target="_blank"` link would. One delegated
 * handler instead of a Words element hook: hooks turn off Words' streaming fast paths. A footnote's `#` link stays in
 * the message.
 */
function openLink(event: MouseEvent<HTMLDivElement>) {
  const link = (event.target as Element).closest('a[href]');
  const href = link?.getAttribute('href');
  if (!link || !href || href.startsWith('#') || !event.currentTarget.contains(link)) return;
  event.preventDefault();
  window.open((link as HTMLAnchorElement).href, '_blank', 'noopener,noreferrer');
}

/** One code plugin per code theme, created once: Words reuses its live tokenizers across updates. */
const codePlugins = new Map<string, PluginConfig>();
function useCodePlugins(id: string) {
  const [plugins, setPlugins] = useState(() => codePlugins.get(id));
  useEffect(() => {
    const ready = codePlugins.get(id);
    if (ready) {
      setPlugins(ready);
      return;
    }
    let live = true;
    void highlightsThemes[id]().then(
      ({ default: theme }) => {
        const loaded = codePlugins.get(id) ?? {
          code: createHighlightsPlugin({ theme: readableHighlightsTheme(theme, `gnosis-${id}`) }),
        };
        codePlugins.set(id, loaded);
        if (live) setPlugins(loaded);
      },
      () => {}
    );
    return () => {
      live = false;
    };
  }, [id]);
  // Until the theme loads, code shows as plain text in the code tier's colours.
  return plugins;
}

/** A closed diff fence: each file under its code-tier header, rendered as Changes renders it. */
function ChatDiff({ patch, theme }: { patch: string; theme: string }) {
  const files = useMemo(() => parseChatDiff(patch) ?? [], [patch]);
  // The saved appearance, as Changes uses it, until a change in Settings publishes another.
  const saved = useDiffAppearance(startupPreferences()?.diffAppearance);
  // Long lines wrap, as Feedback's threads do: the chat column is narrow.
  const appearance = useMemo(() => ({ ...saved, wrap: true }), [saved]);
  return (
    <div className="chat-diff" data-code-theme={theme}>
      {files.map((file, index) => {
        const lines = file.hunks.flatMap((hunk) => hunk.content.split('\n'));
        return (
          <section key={index} className="review-file-group" aria-label={`Diff, ${file.path || 'patch'}`}>
            <DiffFileHeader
              path={file.path || 'patch'}
              additions={lines.filter((line) => line.startsWith('+')).length}
              deletions={lines.filter((line) => line.startsWith('-')).length}
            />
            <ReviewDiff
              filePath={file.path || 'patch'}
              hunks={file.hunks}
              diffLayout="unified"
              appearance={appearance}
              slideIndex={-1}
              plainGaps
              theme={theme}
            />
          </section>
        );
      })}
    </div>
  );
}

const islandsByTheme = new Map<string, ReactiveIslands>();
function diffIslands(theme: string): ReactiveIslands {
  let islands = islandsByTheme.get(theme);
  if (!islands)
    islandsByTheme.set(
      theme,
      (islands = {
        [CHAT_DIFF_ISLAND]: {
          fallback: 'Loading diff…',
          render: (data) =>
            typeof data.patch === 'string' && parseChatDiff(data.patch) ? (
              <ChatDiff patch={data.patch} theme={theme} />
            ) : null,
        },
      })
    );
  return islands;
}

/** Renders only when its text, streaming state or class changes: a transcript re-renders on every chunk. */
export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  streaming = false,
  className,
}: {
  children: string;
  /** Text is still arriving: fades, the caret and live repairs of unfinished Markdown are on. */
  streaming?: boolean;
  className?: string;
}) {
  countRender('ChatMarkdown');
  const saved = useReaderCodeTheme();
  const id = CODE_THEMES.find((t) => t.id === saved)?.id ?? 'github-dark';
  const theme = diffThemeName(id);
  useLayoutEffect(() => applyCodePalette(theme), [theme]);
  const plugins = useCodePlugins(id);
  const source = useMemo(() => withDiffIslands(children), [children]);
  return (
    <Words
      className={cn('markdown-body chat-markdown select-text', className)}
      data-code-theme={theme}
      isAnimating={streaming}
      animated
      caret="block"
      plugins={plugins}
      islands={diffIslands(theme)}
      onClick={openLink}
    >
      {source}
    </Words>
  );
});
