import { createElement, lazy, useState, type ComponentProps, type ComponentType } from 'react';
import { preferencesReady } from './startup-preferences';
import { loadChangePreview } from './inspection-cache';

let diffs: Promise<void> | undefined;
/**
 * Pierre permits one highlighter backend per thread, so configure it once, before any diff mounts.
 * Patch previews load too, so the first inspection can show them at once.
 */
function prepareDiffs() {
  diffs ??= Promise.all([preferencesReady(), import('./diff-highlighter'), loadChangePreview()]).then(
    ([preferences, module]) => module.initializeDiffHighlighter(preferences)
  );
  return diffs;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches React.lazy's own constraint
type AnyComponent = ComponentType<any>;
export type LazyScreen<C extends AnyComponent> = ComponentType<ComponentProps<C>> & { preload: () => Promise<unknown> };

/**
 * A component loaded on first use. Once loaded it renders directly: React.lazy suspends on its
 * first render even when the import has finished, which would show a fallback after a preload.
 */
export function lazyComponent<C extends AnyComponent>(loader: () => Promise<C>): LazyScreen<C> {
  let loading: Promise<{ default: C }> | undefined;
  let loaded: C | undefined;
  const load = () => {
    loading ??= loader().then((component) => {
      loaded = component;
      return { default: component };
    });
    // A failed load can be retried, for example after a dropped dev-server connection.
    loading.catch(() => (loading = undefined));
    return loading;
  };
  const Lazy = lazy(load);
  // Each instance keeps the type it mounted with, so resolving never remounts its content.
  const Screen = (props: ComponentProps<C>) => createElement(useState(() => loaded ?? Lazy)[0], props);
  return Object.assign(Screen, { preload: () => load().catch(() => {}) });
}

/**
 * A screen loaded on first use. Screens that can show diffs must load through here: the loader
 * configures the diff highlighter with the startup preferences before the screen resolves.
 */
export function lazyScreen<C extends AnyComponent>(loader: () => Promise<C>): LazyScreen<C> {
  return lazyComponent(() => Promise.all([loader(), prepareDiffs()]).then(([component]) => component));
}
