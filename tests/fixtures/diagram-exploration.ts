import type { SvgIllustration } from '../../lib/svg-illustration';

/** Authored interaction fixture. Live generated examples are stored separately. */
export const EXPLORATION_FIXTURE: SvgIllustration = {
  version: 1,
  title: 'One read, two callers',
  takeaway: 'Both callers share a pending read; the cache owns the saved result.',
  assumptions: 'An authored fixture for selection, source navigation, and stable geometry.',
  plan: {
    question: 'Who owns the pending read and its result?',
    visualApproach: 'A component map with two clients feeding one cache.',
    whyThisForm: 'Shared ownership is visible without simulating two independent requests.',
    encodings: 'Boxes are responsibilities. Arrows name operations. Changed labels mark the modified component.',
    motion: '',
  },
  exploration: {
    kind: 'component',
    entities: [
      {
        id: 'review',
        label: 'Review',
        summary: 'Requests a file for the active review.',
        change: 'context',
        evidence: { filePath: 'fixture.ts', startLine: 1 },
      },
      { id: 'preload', label: 'Preloader', summary: 'Warms files before the reviewer opens them.', change: 'context' },
      {
        id: 'cache',
        label: 'Revision cache',
        summary: 'Shares the pending read and retains the immutable result.',
        change: 'changed',
        evidence: { filePath: 'fixture.ts', startLine: 2 },
      },
    ],
    relationships: [
      {
        id: 'review-read',
        from: 'review',
        to: 'cache',
        label: 'Read file',
        summary: 'The visible review joins the pending read.',
        evidence: { filePath: 'fixture.ts', startLine: 3 },
      },
      {
        id: 'preload-read',
        from: 'preload',
        to: 'cache',
        label: 'Warm file',
        summary: 'Preloading supplies the same revision key.',
      },
    ],
  },
  scenarios: [
    {
      id: 'map',
      title: 'Shared ownership',
      input: 'Two callers, one revision',
      frames: [
        {
          title: 'The cache owns the read',
          caption: 'The callers share work through the cache.',
          svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 300">
      <g data-relationship-id="review-read"><path d="M190 80 H300 V150 H330" fill="none" stroke="var(--line)" stroke-width="2"/><text x="222" y="65" font-size="16" fill="var(--ink)">Read file</text><path d="M322 145 L330 150 L322 155" fill="none" stroke="var(--line)" stroke-width="2"/></g>
      <g data-relationship-id="preload-read"><path d="M190 220 H270 V180 H330" fill="none" stroke="var(--line)" stroke-width="2"/><text x="200" y="254" font-size="16" fill="var(--ink)">Warm file</text><path d="M322 175 L330 180 L322 185" fill="none" stroke="var(--line)" stroke-width="2"/></g>
      <g data-entity-id="review"><rect x="20" y="45" width="170" height="70" rx="8" fill="var(--paper)" stroke="var(--line)"/><text x="105" y="85" text-anchor="middle" font-size="18" fill="var(--ink)">Review</text></g>
      <g data-entity-id="preload"><rect x="20" y="185" width="170" height="70" rx="8" fill="var(--paper)" stroke="var(--line)"/><text x="105" y="225" text-anchor="middle" font-size="18" fill="var(--ink)">Preloader</text></g>
      <g data-entity-id="cache"><rect x="330" y="110" width="210" height="100" rx="8" fill="var(--paper)" stroke="var(--accent)" stroke-width="2"/><text x="435" y="148" text-anchor="middle" font-size="18" fill="var(--ink)">Revision cache</text><text x="435" y="182" text-anchor="middle" font-size="16" fill="var(--accent)">Changed</text></g>
    </svg>`,
        },
      ],
    },
  ],
};
