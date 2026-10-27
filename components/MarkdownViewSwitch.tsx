import { useState } from 'react';
import { useMarkdownView } from '../lib/use-markdown-view';
import { Button } from './ui/button';

export function MarkdownViewSwitch() {
  const [view, change] = useMarkdownView();
  const [notice, setNotice] = useState('');
  return (
    <>
      <div className="markdown-view-switch" role="group" aria-label="Markdown view">
        {(['source', 'preview'] as const).map((mode) => (
          <Button
            key={mode}
            variant={view.mode === mode ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={view.mode === mode}
            onClick={(event) => {
              const draft = event.currentTarget.closest('.review-file-group')?.querySelector('textarea');
              if (draft) {
                draft.focus();
                setNotice('Finish or cancel your comment before switching views.');
                return;
              }
              setNotice('');
              change({ mode });
            }}
          >
            {mode === 'source' ? 'Source' : 'Preview'}
          </Button>
        ))}
      </div>
      {notice && (
        <span role="status" className="text-xs text-muted-foreground">
          {notice}
        </span>
      )}
    </>
  );
}
