import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, Pause, Play, RotateCcw } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { DiagramViewport } from './DiagramViewport';
import { renderD2, cachedD2, type D2Render } from '../lib/d2';
import type { D2DiagramSpec } from '../lib/types';
import { normalizeD2Diagram, diagramFrameCaption } from '../lib/diagram-spec';
import { namespaceSVG } from '../lib/svg-ids';

/** Rich diagrams in the explanation pane, with optional guided board playback. */
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
  const safe = useMemo(() => normalizeD2Diagram(diagram), [diagram]);
  const source = safe?.source ?? '';
  const instanceId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [retry, setRetry] = useState(0);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const key = JSON.stringify([source, dark]);
  const [result, setResult] = useState<{ key: string; rendered?: D2Render; error?: string } | undefined>(() => {
    const rendered = cachedD2(source, dark);
    return rendered ? { key, rendered } : undefined;
  });
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  const [motion, setMotion] = useState(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  const current = result?.key === key ? result : undefined;
  const frames = current?.rendered?.frames ?? [];
  const index = Math.min(step, Math.max(0, frames.length - 1));
  const frame = frames.length > 0 ? frames[index] : undefined;
  const open = expanded ?? localOpen;
  const setOpen = onExpandedChange ?? setLocalOpen;
  const caption = safe ? diagramFrameCaption(safe, frame?.id ?? '', index) : undefined;
  const svg = useMemo(() => (frame ? namespaceSVG(frame.svg, instanceId) : ''), [frame, instanceId]);
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
    if (!source) {
      setResult({ key, error: 'The saved diagram is incomplete. Regenerate this explanation to replace it.' });
      return;
    }
    const rendered = cachedD2(source, dark);
    setResult(rendered ? { key, rendered } : undefined);
    void renderD2(source, dark).then(
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
  }, [key, source, dark, retry]);
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
    setMotion(false);
    setStep(next);
  }
  const hasMotion = frames.some((item) => item.animated);
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
      {(caption?.description || safe?.caption) && <p>{caption?.description || safe?.caption}</p>}
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
            <div key={index} className="mermaid-preview-canvas d2-frame" dangerouslySetInnerHTML={{ __html: svg }} />
            <span className="mermaid-expand">
              <Maximize2 size={14} /> Expand diagram
            </span>
          </button>
          {controls}
          {explanation}
        </>
      ) : (
        <div className="d2-render-state" role="status">
          {current?.error ? (
            <>
              <span>Diagram unavailable. You can still read the explanation and code.</span>
              <Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>
                Retry diagram
              </Button>
            </>
          ) : (
            'Laying out diagram…'
          )}
        </div>
      )}
      <details className="mermaid-source d2-source">
        <summary>D2 source{current?.error ? ' · render error' : ''}</summary>
        {current?.error && <p role="alert">{current.error}</p>}
        <pre>
          <code>{source}</code>
        </pre>
      </details>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          setPlaying(false);
          setMotion(false);
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
          {open && !frame && (
            <div className="d2-render-state" role="status">
              {current?.error
                ? 'Diagram unavailable. Close this viewer to retry or inspect the source.'
                : 'Laying out diagram…'}
            </div>
          )}
          {open && frame && (
            <>
              <div className="d2-expanded-body">
                <DiagramViewport svg={svg} frameKey={frame.id} />
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
