import type { Theme } from '@pierre/highlights';
import { readableCodeTheme } from './code-contrast';

/** Apply the same changed-line contrast floor to Highlights' Zed-format palette. */
export function readableHighlightsTheme(theme: Theme, name: string): Theme {
  const syntax = Object.entries(theme.style.syntax ?? {});
  const adjusted = readableCodeTheme({
    name,
    type: 'dark',
    colors: {
      'editor.background': theme.style['editor.background'] ?? theme.style.background ?? '#1e1e1e',
      'editor.foreground': theme.style['editor.foreground'] ?? theme.style.text ?? '#ffffff',
    },
    tokenColors: syntax.map(([scope, settings]) => ({
      scope,
      settings: { foreground: typeof settings === 'string' ? settings : settings.color },
    })),
  });
  return {
    ...theme,
    name,
    style: {
      ...theme.style,
      'editor.foreground': adjusted.colors?.['editor.foreground'],
      'gitDecoration.addedResourceForeground': adjusted.colors?.['gitDecoration.addedResourceForeground'],
      'gitDecoration.deletedResourceForeground': adjusted.colors?.['gitDecoration.deletedResourceForeground'],
      syntax: Object.fromEntries(
        syntax.map(([scope, settings], i) => [
          scope,
          {
            ...(typeof settings === 'string' ? {} : settings),
            color: adjusted.tokenColors?.[i].settings.foreground,
          },
        ])
      ),
    },
  };
}
