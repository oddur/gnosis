import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, Pause, Play } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { DiagramViewport } from './DiagramViewport';
import { renderD2, cachedD2, type D2Render } from '../lib/d2';
import type { D2DiagramSpec } from '../lib/types';
import { normalizeD2Diagram } from '../lib/diagram-spec';
import { namespaceSVG } from '../lib/svg-ids';
import { diagramViews, focusDiagram } from '../lib/d2-presentation';

/** Rich diagrams in the explanation pane, with optional guided board playback. */
export function D2Diagram({
  diagram,
  title = 'Diagram',
  expanded,
  onExpandedChange,
  canShowCode,
  onShowCode,
}: {
  diagram: D2DiagramSpec;
  title?: string;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  canShowCode?: (source: { filePath: string; startLine: number }) => boolean;
  onShowCode?: (source: { filePath: string; startLine: number }) => void;
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
  const views = useMemo(() => (safe ? diagramViews(safe, frames) : []), [safe, frames]);
  const index = Math.min(step, Math.max(0, views.length - 1));
  const view = views.length > 0 ? views[index] : undefined;
  const frame = view?.frame;
  const sequential = safe?.kind === 'walkthrough';
  const open = expanded ?? localOpen;
  const setOpen = onExpandedChange ?? setLocalOpen;
  const svg = useMemo(
    () =>
      view
        ? namespaceSVG(focusDiagram(view.frame.svg, view.frame.entities, view.focus, view.differences), instanceId)
        : '',
    [view, instanceId]
  );
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
    if (!playing || views.length < 2) return;
    const timer = window.setTimeout(() => {
      if (index === views.length - 1) {
        setPlaying(false);
        setMotion(false);
      } else setStep(index + 1);
    }, 6500);
    return () => window.clearTimeout(timer);
  }, [playing, index, views.length]);
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
  const navigation = views.length > 1 && (
    <nav className="d2-view-nav" aria-label={sequential ? 'Diagram steps' : 'Diagram views'}>
      {views.map((item, i) => (
        <button type="button" key={item.key} aria-current={i === index ? 'step' : undefined} onClick={() => go(i)}>
          {sequential && (
            <span className="d2-view-number" aria-hidden="true">
              {i + 1}
            </span>
          )}
          <span>{item.title}</span>
        </button>
      ))}
    </nav>
  );
  const controls = views.length > 1 && (
    <div className="d2-playback" role="group" aria-label="Diagram navigation">
      <Button
        variant="ghost"
        size="sm"
        aria-label="Previous diagram step"
        disabled={index === 0}
        onClick={() => go(index - 1)}
      >
        <ChevronLeft /> Previous
      </Button>
      <output className="d2-step-count">
        {sequential ? 'Step' : 'View'} {index + 1} of {views.length}
      </output>
      <Button
        variant="outline"
        size="sm"
        aria-label="Next diagram step"
        disabled={index === views.length - 1}
        onClick={() => go(index + 1)}
      >
        {sequential ? 'Next step' : 'Next view'} <ChevronRight />
      </Button>
      {sequential && (
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={playing}
          onClick={() => {
            if (index === views.length - 1) setStep(0);
            setPlaying(!playing);
            setMotion(!playing);
          }}
        >
          {playing ? <Pause /> : <Play />} {playing ? 'Pause auto-play' : 'Auto-play steps'}
        </Button>
      )}
    </div>
  );
  const explanation = view && (
    <div className="d2-caption" aria-live={playing ? 'off' : 'polite'}>
      <strong>{view.title}</strong>
      {view.change && view.change !== view.title && view.change !== view.description && (
        <p className="d2-change">{view.change}</p>
      )}
      {view.description && view.description !== view.title && <p>{view.description}</p>}
      {view.evidence && onShowCode && canShowCode?.(view.evidence) && (
        <Button
          variant="link"
          size="sm"
          className="d2-code-link"
          onClick={() => {
            setOpen(false);
            setPlaying(false);
            setMotion(false);
            const evidence = view.evidence;
            if (evidence) requestAnimationFrame(() => onShowCode(evidence));
          }}
        >
          Show supporting code
        </Button>
      )}
      {view.differences.length > 0 && (
        <details key={view.key} className="d2-differences">
          <summary>Changes in this step ({view.differences.length})</summary>
          <dl>
            {view.differences.map((difference) => (
              <div key={difference.label}>
                <dt>{difference.label}</dt>
                <dd>
                  <span>{difference.before}</span>
                  <ChevronRight size={14} aria-label="becomes" />
                  <strong>{difference.after}</strong>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
  return (
    <figure className="d2-diagram" data-motion={motion} aria-label={title}>
      {frame ? (
        <>
          {navigation}
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
              key={frame.layoutId ?? frame.id}
              className="mermaid-preview-canvas d2-frame"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
            <span className="mermaid-expand">
              <Maximize2 size={14} /> Expand diagram
            </span>
          </button>
          {explanation}
          {controls}
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
                <DiagramViewport
                  svg={svg}
                  frameKey={frame.layoutId ?? frame.id}
                  onEntitySelect={(id) => {
                    const match = views.findIndex(
                      (item) =>
                        item.focus.includes(id) ||
                        item.frame.entities.some(
                          (entity) => item.focus.includes(entity.id) && (entity.src === id || entity.dst === id)
                        )
                    );
                    if (match >= 0) go(match);
                  }}
                />
                <aside className="d2-notes" aria-label="Diagram explanation">
                  {navigation}
                  {explanation}
                  {frame.notes.length > 0 && (
                    <details className="d2-additional-notes">
                      <summary>More about this diagram ({frame.notes.length})</summary>
                      {frame.notes.map((note, i) => (
                        <div key={i}>
                          <strong>{note.subject}</strong>
                          <p>{note.text}</p>
                        </div>
                      ))}
                    </details>
                  )}
                </aside>
              </div>
              <div className="d2-expanded-footer">{controls}</div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </figure>
  );
}
