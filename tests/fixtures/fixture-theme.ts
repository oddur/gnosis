import { applyTheme, type ThemeChoice } from '../../lib/theme';

/**
 * The theme a fixture page asks for with `?theme=light|dark|system`, or undefined. The documentation screenshots
 * (scripts/capture-docs-screenshots.mjs) capture every scene in both themes this way.
 */
export function fixtureTheme(search = location.search): ThemeChoice | undefined {
  const value = new URLSearchParams(search).get('theme');
  return value === 'light' || value === 'dark' || value === 'system' ? value : undefined;
}

/** Applies `?theme=` as the app does at startup (src/renderer.tsx). Without it, the page keeps its own default. */
export function applyFixtureTheme(): void {
  const theme = fixtureTheme();
  if (theme) applyTheme(theme);
}
