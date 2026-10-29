import type { SvgIllustration } from '../../lib/svg-illustration';
/** Authored playback fixture. Not included among model-generated examples. */
export const SVG_MOTION_FIXTURE: SvgIllustration = {
  version: 1,
  title: 'Move the same item',
  takeaway: 'A stable identity follows the same object through saved positions.',
  assumptions: 'Synthetic playback test; positions are schematic.',
  plan: {
    question: 'Does playback preserve identity?',
    visualApproach: 'An item moves across a fixed track.',
    whyThisForm: 'A fixed track makes continuity visible.',
    encodings: 'Positions indicate successive states, not elapsed time.',
    motion: 'Follow A as it moves.',
  },
  scenarios: [
    {
      id: 'forward',
      title: 'Forward',
      input: 'Authored test fixture',
      frames: [0, 1, 2].map((i) => ({
        title: `Position ${i + 1}`,
        caption: `A occupies position ${i + 1}.`,
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 220"><path d="M 60 110 L 480 110" stroke="var(--line)" fill="none"/><g data-motion-id="item-a" transform="translate(${60 + i * 200} 110)"><circle r="24" fill="var(--paper)" stroke="var(--accent)"/><text y="7" text-anchor="middle" font-size="20">A</text></g></svg>`,
      })),
    },
    {
      id: 'backward',
      title: 'Backward',
      input: 'Authored test fixture',
      frames: [2, 1, 0].map((i) => ({
        title: `Position ${i + 1}`,
        caption: `A occupies position ${i + 1}.`,
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 220"><path d="M 60 110 L 480 110" stroke="var(--line)" fill="none"/><g data-motion-id="item-a" transform="translate(${60 + i * 200} 110)"><circle r="24" fill="var(--paper)" stroke="var(--accent)"/><text y="7" text-anchor="middle" font-size="20">A</text></g></svg>`,
      })),
    },
  ],
};
