import { useEffect, useRef, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { renderMermaid } from '../lib/mermaid';

export function MermaidDiagram({ chart }: { chart: string }) {
  const expandButton = useRef<HTMLButtonElement>(null);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const [result, setResult] = useState<{ chart: string; dark: boolean; svg?: string; failed?: boolean }>();
  const [open, setOpen] = useState(false);
  const current = result?.chart === chart && result.dark === dark ? result : undefined;

  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void renderMermaid(chart, dark).then(
      (svg) => {
        if (!cancelled) setResult({ chart, dark, svg });
      },
      () => {
        if (!cancelled) setResult({ chart, dark, failed: true });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [chart, dark]);

  return (
    <figure className="mermaid-diagram" data-theme={dark ? 'dark' : 'light'} aria-label="Mermaid diagram">
      {current?.svg ? (
        <button
          ref={expandButton}
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Expand diagram"
          aria-haspopup="dialog"
          aria-expanded={open}
          title="Expand diagram"
          className="mermaid-preview group relative w-full rounded-md bg-muted/30 p-3 cursor-pointer transition-colors hover:bg-muted/50 text-left max-h-[600px] overflow-auto"
        >
          <div dangerouslySetInnerHTML={{ __html: current.svg }} />
          <span className="absolute top-2 right-2 rounded-md bg-background/60 p-1 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity">
            <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
        </button>
      ) : (
        <p className="text-sm text-muted-foreground" role="status">
          {current?.failed ? 'Could not render this diagram. Its source is shown below.' : 'Rendering diagram…'}
        </p>
      )}
      {current?.failed ? (
        <pre>
          <code>{chart}</code>
        </pre>
      ) : (
        <details className="mermaid-source">
          <summary>Diagram source</summary>
          <pre>
            <code>{chart}</code>
          </pre>
        </details>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="sm:max-w-[90vw] max-h-[90vh] flex flex-col"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            expandButton.current?.focus({ preventScroll: true });
          }}
        >
          <DialogTitle className="sr-only">Diagram</DialogTitle>
          <div
            className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-4 mermaid-fullscreen"
            dangerouslySetInnerHTML={current?.svg ? { __html: current.svg } : undefined}
          />
        </DialogContent>
      </Dialog>
    </figure>
  );
}
