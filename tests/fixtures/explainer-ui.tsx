import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { ExplainerView } from '../../components/ExplainerView';
import { explainer, slide } from './explainer';
import type { GenerateExplainerRequest } from '../../lib/types';

Object.defineProperty(window, 'electronAPI', {
  value: {
    generateExplainer: async (req: GenerateExplainerRequest) => {
      if (req.refinement === 'background') {
        await new Promise((resolve) => setTimeout(resolve, 300));
        document.body.dataset.backgroundCompleted = 'true';
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (req.refinement === 'fail') throw new Error('Example generation failed.');
      return { ...explainer, title: req.refinement ? 'Refined queue' : explainer.title };
    },
    cancelExplainer: () => {
      document.body.dataset.cancelled = 'true';
      return Promise.resolve();
    },
  },
});
function Preview() {
  const [closed, setClosed] = useState(false);
  return closed ? (
    <p>Returned to review</p>
  ) : (
    <ExplainerView
      reviewId="review-1"
      slide={slide}
      onClose={() => setClosed(true)}
      onSaved={() => {
        document.body.dataset.saved = 'true';
      }}
    />
  );
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<Preview />);
