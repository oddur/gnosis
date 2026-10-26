import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Maximize2 } from 'lucide-react';
import { DiagramViewport } from './DiagramViewport';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { renderMermaid } from '../lib/mermaid';

export function MermaidDiagram({
  chart,
  title = 'Diagram',
  expanded,
  onExpandedChange,
}: {
  chart: string;
  title?: string;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
}) {
  const expandButton = useRef<HTMLButtonElement>(null);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const [result, setResult] = useState<{ chart: string; dark: boolean; svg?: string; failed?: boolean }>();
  const [localOpen, setLocalOpen] = useState(false);
  const open = expanded ?? localOpen;
  const setOpen = onExpandedChange ?? setLocalOpen;
  const figure = useRef<HTMLElement>(null);
  const [previewHeight, setPreviewHeight] = useState(320);
  useLayoutEffect(() => {
    let parent = figure.current?.parentElement;
    while (parent && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
    const boundary = parent ?? document.documentElement;
    const measure = () => {
      if (boundary.clientHeight > 0) setPreviewHeight(Math.max(96, Math.min(320, boundary.clientHeight - 100)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(boundary);
    return () => observer.disconnect();
  }, []);
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
    <figure
      ref={figure}
      style={{ '--mermaid-preview-height': `${previewHeight}px` } as CSSProperties}
      className="mermaid-diagram"
      data-theme={dark ? 'dark' : 'light'}
      aria-label="Mermaid diagram"
    >
      {current?.svg ? (
        <button
          ref={expandButton}
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Expand diagram"
          aria-haspopup="dialog"
          aria-expanded={open}
          title="Expand diagram"
          className="mermaid-preview"
        >
          <div className="mermaid-preview-canvas" dangerouslySetInnerHTML={{ __html: current.svg }} />
          <span className="mermaid-expand">
            <Maximize2 size={14} aria-hidden="true" /> Expand diagram
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
          className="mermaid-dialog"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            expandButton.current?.focus({ preventScroll: true });
          }}
        >
          <DialogTitle className="mermaid-dialog-title">{title}</DialogTitle>
          {open && current?.svg && <DiagramViewport svg={current.svg} />}
        </DialogContent>
      </Dialog>
    </figure>
  );
}
