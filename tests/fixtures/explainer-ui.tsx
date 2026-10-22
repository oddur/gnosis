import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { ExplainerView } from '../../components/ExplainerView';
import { explainer, slide } from './explainer';
import type { GenerateExplainerRequest } from '../../lib/types';

Object.defineProperty(window, 'electronAPI', {
  value: {
    generateExplainer: async (req: GenerateExplainerRequest) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (req.refinement === 'fail') throw new Error('Example generation failed.');
      return { ...explainer, title: req.refinement ? 'Refined queue' : explainer.title };
    },
    cancelExplainer: () => Promise.resolve(),
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
