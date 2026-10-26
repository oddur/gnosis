import { createRoot } from 'react-dom/client';
import { PrChangesView } from '../../components/PrChangesView';
import { commitPositionId } from '../../lib/inspection-cache';
import type { ReviewSubject } from '../../lib/workbench';
import type { PrChanges } from '../../lib/pr-changes';
import type { Preferences } from '../../lib/types';

/** Isolated large-comparison fixture; every GitHub operation still uses the browser suite's mocks. */
export function mountLargeComparison(subject: ReviewSubject, snapshot: PrChanges, preferences: Preferences) {
  localStorage.setItem(
    `gnosis-changes-position:${commitPositionId(subject.id, snapshot)}`,
    JSON.stringify({ selected: 'src/file119.ts', scroll: {} })
  );
  const element = document.createElement('div');
  element.id = 'large-stream-test';
  Object.assign(element.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '9999',
    display: 'flex',
    background: 'var(--background)',
  });
  document.body.appendChild(element);
  createRoot(element).render(
    <PrChangesView
      subject={subject}
      preferences={preferences}
      commit={{
        snapshot,
        sidebar: null,
        header: null,
        status: null,
        tools: null,
        fileStatus: '',
        filesOpen: true,
        toggleFiles: () => {},
        onOpenCurrentFile: () => {},
      }}
    />
  );
}
