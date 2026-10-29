import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, Pause, Play, RotateCcw } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import type { MechanismEvidence } from '../lib/mechanism';
import { normalizeSvgIllustration, type SvgIllustration as Illustration } from '../lib/svg-illustration';
import { buildSvgIllustrationDocument } from '../lib/svg-illustration-document';
import './mechanism-diagram.css';
import './svg-illustration.css';

export function SvgIllustration({
  illustration,
  expanded,
  onExpandedChange,
  canShowCode,
  onShowCode,
}: {
  illustration: Illustration;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  canShowCode?: (e: MechanismEvidence) => boolean;
  onShowCode?: (e: MechanismEvidence) => void;
}) {
  const safe = useMemo(() => normalizeSvgIllustration(illustration), [illustration]);
  if (!safe)
    return (
      <p className="text-sm text-muted-foreground">
        Illustration unavailable. The explanation and code are still available.
      </p>
    );
  return (
    <IllustrationPlayer
      key={JSON.stringify(safe)}
      illustration={safe}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      canShowCode={canShowCode}
      onShowCode={onShowCode}
    />
  );
}
function IllustrationPlayer({
  illustration,
  expanded,
  onExpandedChange,
  canShowCode,
  onShowCode,
}: {
  illustration: Illustration;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  canShowCode?: (e: MechanismEvidence) => boolean;
  onShowCode?: (e: MechanismEvidence) => void;
}) {
  const [scenario, setScenario] = useState(0),
    [index, setIndex] = useState(0),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1),
    [localOpen, setLocalOpen] = useState(false);
  const [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [ratio, setRatio] = useState(560 / 300),
    [reload, setReload] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null),
    expandButton = useRef<HTMLButtonElement>(null),
    inline = useRef<HTMLDivElement>(null),
    inlineHeight = useRef(0);
  const current = useRef({ scenario, index });
  current.current = { scenario, index };
  const dark = useRef(document.documentElement.classList.contains('dark'));
  const documentState = useMemo(() => {
    const token = crypto.randomUUID();
    return { token, html: buildSvgIllustrationDocument(illustration, token, dark.current ? 'dark' : 'light') };
  }, [illustration, reload]);
  const open = expanded ?? localOpen,
    setOpen = onExpandedChange ?? setLocalOpen;
  const selected = illustration.scenarios[scenario],
    frame = selected.frames[index],
    last = selected.frames.length - 1;
  function send(command: string, extra: Record<string, unknown> = {}) {
    frameRef.current?.contentWindow?.postMessage(
      { type: 'gnosis-illustration-control', token: documentState.token, command, ...extra },
      '*'
    );
  }
  useEffect(() => {
    setReady(false);
    setPlaying(false);
    setError('');
    const timeout = window.setTimeout(() => setError('The illustration did not load. Reload it to try again.'), 8000);
    const receive = (event: MessageEvent) => {
      const raw: unknown = event.data;
      if (event.source !== frameRef.current?.contentWindow || !raw || typeof raw !== 'object') return;
      const data = raw as Record<string, unknown>;
      if (data.type !== 'gnosis-illustration' || data.token !== documentState.token) return;
      if (data.event === 'ready') {
        clearTimeout(timeout);
        setReady(true);
        if (typeof data.width === 'number' && typeof data.height === 'number' && data.height > 0)
          setRatio(data.width / data.height);
        send('theme', { dark: dark.current });
        send('show', { ...current.current, animate: false });
      }
      if (data.event === 'error') {
        clearTimeout(timeout);
        setError(typeof data.message === 'string' ? data.message : 'Illustration unavailable.');
        setReady(false);
        setPlaying(false);
      }
    };
    window.addEventListener('message', receive);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener('message', receive);
    };
  }, [documentState, open]);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      dark.current = document.documentElement.classList.contains('dark');
      send('theme', { dark: dark.current });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    const visibility = () => {
      if (document.hidden) {
        setPlaying(false);
        send('pause');
      }
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [documentState]);
  useEffect(() => {
    if (!playing || !ready) return;
    const timer = window.setTimeout(() => {
      if (index >= last) setPlaying(false);
      else {
        setIndex(index + 1);
        send('show', { scenario, index: index + 1, animate: true });
      }
    }, 2400 / speed);
    return () => clearTimeout(timer);
  }, [playing, ready, index, last, scenario, speed, documentState]);
  function go(next: number, animate = true) {
    setPlaying(false);
    setIndex(next);
    send('show', { scenario, index: next, animate });
  }
  const controls = last > 0 && (
    <div className="mechanism-controls" role="group" aria-label="Illustration playback">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Previous illustration step"
        disabled={!ready || index === 0}
        onClick={() => go(index - 1)}
      >
        <ChevronLeft size={16} />
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!ready}
        aria-label={playing ? 'Pause illustration' : 'Play illustration'}
        aria-pressed={playing}
        onClick={() => {
          if (index === last) go(0, false);
          if (playing) send('pause');
          else send('resume');
          setPlaying(!playing);
        }}
      >
        {playing ? <Pause size={15} /> : <Play size={15} />} {playing ? 'Pause' : 'Play'}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Next illustration step"
        disabled={!ready || index === last}
        onClick={() => go(index + 1)}
      >
        <ChevronRight size={16} />
      </Button>
      <input
        className="mechanism-scrubber"
        type="range"
        aria-label="Illustration timeline"
        min={0}
        max={last}
        step={1}
        value={index}
        disabled={!ready}
        aria-valuetext={`${index + 1} of ${last + 1}: ${frame.title}`}
        onChange={(e) => go(Number(e.target.value), false)}
      />
      <label className="mechanism-speed">
        <span className="sr-only">Playback speed</span>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          <option value={0.5}>0.5×</option>
          <option value={1}>1×</option>
          <option value={2}>2×</option>
        </select>
      </label>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Restart illustration"
        disabled={!ready}
        onClick={() => go(0, false)}
      >
        <RotateCcw size={15} />
      </Button>
    </div>
  );
  const scenarios = (
    <div className="mechanism-scenarios">
      {illustration.scenarios.length > 1 && (
        <label>
          Scenario{' '}
          <select
            aria-label="Illustration scenario"
            disabled={!ready}
            value={scenario}
            onChange={(e) => {
              const s = Number(e.target.value);
              setScenario(s);
              setIndex(0);
              setPlaying(false);
              send('show', { scenario: s, index: 0, animate: false });
            }}
          >
            {illustration.scenarios.map((s, i) => (
              <option key={s.id} value={i}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <p>{selected.input}</p>
    </div>
  );
  const caption = (
    <div className="mechanism-caption" aria-live={playing ? 'off' : 'polite'}>
      <div className="mechanism-event-heading">
        <span className="mechanism-event-count">
          {index + 1} / {last + 1}
        </span>
        <strong>{frame.title}</strong>
      </div>
      <p>{frame.caption}</p>
      {frame.evidence && onShowCode && canShowCode?.(frame.evidence) && (
        <Button
          variant="link"
          size="sm"
          onClick={() => {
            const evidence = frame.evidence;
            if (evidence) {
              setPlaying(false);
              setOpen(false);
              requestAnimationFrame(() => onShowCode(evidence));
            }
          }}
        >
          Show supporting code
        </Button>
      )}
    </div>
  );
  const drawing = (
    <div className="svg-illustration-stage" style={{ aspectRatio: ratio }}>
      {error ? (
        <div role="alert">
          <p>Illustration unavailable. You can still read the explanation and code.</p>
          <details>
            <summary>Details</summary>
            <p>{error}</p>
          </details>
          <Button variant="outline" size="sm" onClick={() => setReload((r) => r + 1)}>
            Reload illustration
          </Button>
        </div>
      ) : (
        <iframe
          ref={frameRef}
          title={illustration.title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={documentState.html}
        />
      )}
    </div>
  );
  return (
    <figure className="mechanism-diagram svg-illustration" aria-label={illustration.title}>
      <div className="mechanism-intro">
        <p>{illustration.takeaway}</p>
        <Button
          ref={expandButton}
          variant="ghost"
          size="icon"
          aria-label="Expand illustration"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => {
            inlineHeight.current = inline.current?.getBoundingClientRect().height ?? 0;
            setPlaying(false);
            setOpen(true);
          }}
        >
          <Maximize2 size={16} />
        </Button>
      </div>
      {open ? (
        <div style={{ height: inlineHeight.current }} aria-hidden="true" />
      ) : (
        <div ref={inline}>
          {scenarios}
          {controls}
          {drawing}
          {caption}
        </div>
      )}
      <details className="mechanism-assumptions">
        <summary>About this illustration</summary>
        <p>{illustration.assumptions}</p>
        <p>{illustration.plan.encodings}</p>
        {illustration.plan.motion && <p>Playback shows event order, not elapsed execution time.</p>}
      </details>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          setPlaying(false);
        }}
      >
        <DialogContent
          className="mechanism-dialog svg-illustration-dialog"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            expandButton.current?.focus({ preventScroll: true });
          }}
        >
          <DialogTitle>{illustration.title}</DialogTitle>
          {open && (
            <>
              <p className="mechanism-takeaway">{illustration.takeaway}</p>
              {scenarios}
              {controls}
              {drawing}
              {caption}
            </>
          )}
        </DialogContent>
      </Dialog>
    </figure>
  );
}
