import { activeWorkspaceRoot } from '../lib/workspace-navigation';
import { useEffect, useRef } from 'react';
import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { menubarTourFallback, type MenubarShowResult } from '../lib/desktop-setup';
interface TourStep {
  /** No target: the popover sits in the middle of the window. */
  target?: string;
  title: string;
  description: string;
}
const steps: TourStep[] = [
  {
    target: '[data-tour="queue"]',
    title: 'Your Review Queue',
    description: 'Switch saved views and use filters to choose what needs your attention.',
  },
  {
    target: '[data-tour="summary"]',
    title: 'Understand the PR',
    description: 'Read the author’s description and check review status before opening the code.',
  },
  {
    target: '[data-tour="changes"]',
    title: 'Inspect the changes',
    description: 'Read diffs and comments, then mark files Viewed to keep your place.',
  },
  {
    target: '[data-tour="explanation"]',
    title: 'Go deeper when needed',
    description: 'Generate an explanation here; press C in a review or file diff to open chat.',
  },
];
/** macOS, after the queue steps, when the icon is on in panel mode (`offerMenubarTourStop`). Points at nothing in the window. */
export const MENUBAR_TOUR_STOP: TourStep = {
  title: 'Gnosis is also in your menu bar',
  description: 'Click the icon to see what needs you and open a PR without switching windows.',
};
export function GuidedTour({
  step,
  prepare,
  onStep,
  onClose,
  stacked,
  local = false,
  onShowMenubar,
}: {
  step: number;
  prepare: (step: number) => boolean;
  onStep: (step: number) => void;
  onClose: (complete?: boolean) => void;
  stacked: boolean;
  local?: boolean;
  /** Adds the menu bar stop last; its Show me opens the summary panel through `menubar-show`. */
  onShowMenubar?: () => Promise<MenubarShowResult>;
}) {
  const latest = useRef({ prepare, onStep, onClose, stacked, onShowMenubar });
  latest.current = { prepare, onStep, onClose, stacked, onShowMenubar };
  const menubar = !local && !!onShowMenubar;
  useEffect(() => {
    const list = menubar ? [...steps, MENUBAR_TOUR_STOP] : steps;
    const total = local ? 1 : list.length;
    // A saved step past the end (the menu bar stop is no longer offered) resumes at the last stop.
    const index = local ? 0 : Math.min(Math.max(0, step), total - 1);
    const entry: TourStep = local
      ? {
          target: '[data-tour="local"]',
          title: 'Review local changes',
          description: 'Choose a repository on your computer to review local changes. Reopen saved explanations from Saved reviews. GitHub sign-in is optional.',
        }
      : list[index];
    let cleaned = false;
    const available = latest.current.prepare(index);
    const tour = driver({
      animate: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      duration: 160,
      smoothScroll: false,
      allowClose: true,
      allowScroll: true,
      disableActiveInteraction: false,
      overlayClickBehavior: 'none',
      overlayOpacity: 0.5,
      stagePadding: 6,
      stageRadius: 6,
      popoverClass: 'gnosis-tour',
      closeBtnLabel: 'End tour',
      showButtons: ['previous', 'next', 'close'],
      disableButtons: index === 0 ? ['previous'] : [],
      nextBtnText: index === total - 1 ? 'Finish tour' : 'Next',
      prevBtnText: 'Back',
      onNextClick: () =>
        !available
          ? latest.current.onClose(false)
          : index === total - 1
            ? latest.current.onClose(true)
            : latest.current.onStep(step + 1),
      onPrevClick: () => latest.current.onStep(Math.max(0, step - 1)),
      onCloseClick: () => latest.current.onClose(false),
      onDestroyed: () => {
        if (!cleaned) latest.current.onClose(false);
      },
      onPopoverRender: (popover) => {
        const progress = document.createElement('span');
        progress.className = 'gnosis-tour-progress';
        progress.textContent = `${index + 1} of ${total}`;
        popover.footer.prepend(progress);
        if (entry !== MENUBAR_TOUR_STOP) return;
        const show = document.createElement('button');
        show.type = 'button';
        show.className = 'gnosis-tour-action';
        show.textContent = 'Show me';
        show.addEventListener('click', () => {
          show.disabled = true;
          void (latest.current.onShowMenubar?.() ?? Promise.resolve<MenubarShowResult>('unsupported'))
            .catch((): MenubarShowResult => 'unsupported')
            .then((result) => {
              show.disabled = false;
              const fallback = menubarTourFallback(result);
              if (fallback) popover.description.textContent = fallback;
            });
        });
        popover.nextButton.before(show);
      },
    });
    const show = () => {
      let element = entry.target ? activeWorkspaceRoot().querySelector(entry.target) : null;
      if (!local && index === 0 && (!element || !element.getBoundingClientRect().height)) {
        element = activeWorkspaceRoot().querySelector('[data-tour="queue-fallback"]');
      }
      if (!element && available && entry.target) return false;
      tour.highlight({
        element: element ?? undefined,
        popover: {
          showButtons: ['previous', 'next', 'close'],
          title: available ? entry.title : 'Your first PR will go here',
          description: !available
            ? 'Open a PR from the queue or paste its URL, then resume Show walkthrough from Help.'
            : element?.getAttribute('data-tour') === 'queue-fallback'
              ? 'Open your PRs here and use filters to choose what needs your attention. Save a view to return to those filters later.'
              : `${entry.description}${index === 1 && latest.current.stacked ? ' This is a stack: related PRs stay grouped, and you can open each PR separately.' : ''}`,
          side: index === 0 ? 'right' : 'bottom',
          align: index === 0 ? 'start' : 'center',
        },
      });
      return true;
    };
    let observer: MutationObserver | undefined;
    const timer = setTimeout(() => {
      observer?.disconnect();
      if (!tour.isActive())
        tour.highlight({
          popover: {
            showButtons: ['previous', 'next', 'close'],
            title: entry.title,
            description: 'This part of the page is not available yet. You can end the tour and resume it from Help.',
          },
        });
    }, 3000);
    // React may still be switching from the queue to the selected PR.
    const frame = requestAnimationFrame(() => {
      if (!show()) {
        observer = new MutationObserver(() => {
          if (show()) observer?.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }
    });
    return () => {
      cleaned = true;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      observer?.disconnect();
      tour.destroy();
    };
  }, [step, local, menubar]);
  return null;
}
