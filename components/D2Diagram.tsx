import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, Pause, Play, RotateCcw } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { MermaidViewport } from './MermaidViewport';
import { renderD2, type D2Render } from '../lib/d2';
import type { D2DiagramSpec } from '../lib/types';

/** Prototype replacement for generated Mermaid diagrams; legacy content keeps its renderer. */
export function D2Diagram({
  diagram,
  title = 'Diagram',
  expanded,
  onExpandedChange,
}: {
  diagram: D2DiagramSpec;
  title?: string;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
}) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const [result, setResult] = useState<{ key: string; rendered?: D2Render; error?: string }>();
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  const [motion, setMotion] = useState(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  const key = JSON.stringify([diagram.source, dark]);
  const current = result?.key === key ? result : undefined;
  const frames = current?.rendered?.frames ?? [];
  const index = Math.min(step, Math.max(0, frames.length - 1));
  const frame = frames.length > 0 ? frames[index] : undefined;
  const open = expanded ?? localOpen;
  const setOpen = onExpandedChange ?? setLocalOpen;
  const caption = diagram.steps?.[index];
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let cancelled = false;
    setStep(0);
    setPlaying(false);
    setMotion(false);
    void renderD2(diagram.source, dark).then(
      (rendered) => {
        if (!cancelled) setResult({ key, rendered });
      },
      (error: unknown) => {
        if (!cancelled) setResult({ key, error: error instanceof Error ? error.message : String(error) });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [key, diagram.source, dark]);
  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const timer = window.setTimeout(() => {
      if (index === frames.length - 1) {
        setPlaying(false);
        setMotion(false);
      } else setStep(index + 1);
    }, 3200);
    return () => window.clearTimeout(timer);
  }, [playing, index, frames.length]);
  useEffect(() => {
    const stop = () => {
      if (document.hidden) {
        setPlaying(false);
        setMotion(false);
      }
    };
    document.addEventListener('visibilitychange', stop);
    return () => document.removeEventListener('visibilitychange', stop);
  }, []);
  function go(next: number) {
    setPlaying(false);
    setStep(next);
  }
  const hasMotion = /animated:\s*true/.test(diagram.source);
  const controls = (
    <div className="d2-playback" role="group" aria-label="Diagram walkthrough">
      {frames.length > 1 && (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous diagram step"
            disabled={index === 0}
            onClick={() => go(index - 1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (index === frames.length - 1) setStep(0);
              setPlaying(!playing);
              setMotion(!playing);
            }}
          >
            {playing ? <Pause /> : <Play />} {playing ? 'Pause' : 'Play'}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next diagram step"
            disabled={index === frames.length - 1}
            onClick={() => go(index + 1)}
          >
            <ChevronRight />
          </Button>
          <output className="d2-step-count">
            {index + 1} / {frames.length}
          </output>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Reset diagram walkthrough"
            disabled={index === 0 && !playing}
            onClick={() => go(0)}
          >
            <RotateCcw />
          </Button>
        </>
      )}
      {hasMotion && (
        <Button variant="ghost" size="sm" aria-pressed={motion} onClick={() => setMotion(!motion)}>
          {motion ? <Pause /> : <Play />} {motion ? 'Pause flow' : 'Animate flow'}
        </Button>
      )}
    </div>
  );
  const explanation = (
    <div className="d2-caption" aria-live={playing ? 'off' : 'polite'}>
      {frames.length > 1 && (
        <strong>{caption?.title || (index === 0 ? 'Overview' : frame?.name.replace(/_/g, ' '))}</strong>
      )}
      {(caption?.description || diagram.caption) && <p>{caption?.description || diagram.caption}</p>}
    </div>
  );
  return (
    <figure className="d2-diagram" data-motion={motion} aria-label={title}>
      {frame ? (
        <>
          <button
            ref={expandButton}
            type="button"
            className="mermaid-preview d2-preview"
            aria-label="Expand diagram"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            <div
              key={index}
              className="mermaid-preview-canvas d2-frame"
              dangerouslySetInnerHTML={{ __html: frame.svg }}
            />
            <span className="mermaid-expand">
              <Maximize2 size={14} /> Expand diagram
            </span>
          </button>
          {controls}
          {explanation}
        </>
      ) : (
        <div className="d2-render-state" role="status">
          {current?.error ? 'This diagram could not render. Inspect its source below.' : 'Laying out diagram…'}
        </div>
      )}
      <details className="mermaid-source d2-source">
        <summary>D2 source{current?.error ? ' · render error' : ''}</summary>
        {current?.error && <p role="alert">{current.error}</p>}
        <pre>
          <code>{diagram.source}</code>
        </pre>
      </details>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          setPlaying(false);
        }}
      >
        <DialogContent
          className="mermaid-dialog d2-dialog"
          data-motion={motion}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            expandButton.current?.focus({ preventScroll: true });
          }}
        >
          <DialogTitle className="mermaid-dialog-title">{title}</DialogTitle>
          {open && frame && (
            <>
              <div className="d2-expanded-body">
                <MermaidViewport svg={frame.svg} />
                {frame.notes.length > 0 && (
                  <aside className="d2-notes" aria-label="Diagram annotations">
                    <h3>What to notice</h3>
                    {frame.notes.map((note, i) => (
                      <div key={i}>
                        <strong>{note.subject}</strong>
                        <p>{note.text}</p>
                      </div>
                    ))}
                  </aside>
                )}
              </div>
              <div className="d2-expanded-footer">
                {controls}
                {explanation}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </figure>
  );
}
