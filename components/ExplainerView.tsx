import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, LoaderCircle, Pause, Play, RotateCcw, SkipForward } from 'lucide-react';
import { Button } from './ui/button';
import { buildExplainerDocument } from '../lib/explainer-document';
import type { InteractiveExplainer, Slide } from '../lib/types';

interface Props {
  reviewId: string;
  slide: Slide;
  onClose: () => void;
  onSaved: (artifact: InteractiveExplainer) => void;
}

export function ExplainerView({ reviewId, slide, onClose, onSaved }: Props) {
  const [artifact, setArtifact] = useState(slide.explainer);
  const [busy, setBusy] = useState(!slide.explainer);
  const [error, setError] = useState('');
  const [runtimeError, setRuntimeError] = useState('');
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [refinement, setRefinement] = useState('');
  const [source, setSource] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [fit, setFit] = useState(true);
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'));
  const frameRef = useRef<HTMLIFrameElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const pending = useRef(false);
  const req = { reviewId, slideId: slide.id };
  const documentState = useMemo(() => {
    if (!artifact) return null;
    const token = crypto.randomUUID();
    return { token, html: buildExplainerDocument(artifact, token, dark ? 'dark' : 'light') };
    // Reload deliberately creates a fresh sandbox after a runtime error.
  }, [artifact, dark, reload]);

  async function generate(instruction?: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    control('pause');
    try {
      const result = await window.electronAPI.generateExplainer({ ...req, refinement: instruction });
      if (!alive.current) return;
      setArtifact(result);
      setRefinement('');
      onSaved(result);
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    backRef.current?.focus();
    if (!slide.explainer) void generate();
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      alive.current = false;
      observer.disconnect();
      void window.electronAPI.cancelExplainer(req);
    };
  }, []);

  useEffect(() => {
    setReady(false);
    setPlaying(false);
    setFit(true);
    setRuntimeError('');
    if (!documentState) return;
    const timer = setTimeout(
      () => setRuntimeError('The interactive view did not become ready. Reload it or ask for a simpler example.'),
      10000
    );
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || !event.data || typeof event.data !== 'object') return;
      const data = event.data as Record<string, unknown>;
      if (data.type !== 'gnosis-explainer' || data.token !== documentState.token) return;
      if (data.event === 'ready') {
        clearTimeout(timer);
        setReady(true);
      }
      if (data.event === 'state') setPlaying(data.playing === true);
      if (data.event === 'error') {
        clearTimeout(timer);
        setRuntimeError(
          typeof data.message === 'string' ? data.message.slice(0, 500) : 'The interactive view encountered an error.'
        );
        setReady(false);
        setPlaying(false);
      }
    };
    window.addEventListener('message', receive);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('message', receive);
    };
  }, [documentState]);

  function control(command: string) {
    if (documentState)
      frameRef.current?.contentWindow?.postMessage(
        { type: 'gnosis-explainer-control', token: documentState.token, command },
        '*'
      );
  }

  return (
    <section
      className="flex-1 min-h-0 flex flex-col overflow-y-auto px-4 py-3 lg:px-6"
      aria-label="Interactive explanation"
    >
      <div className="flex items-center gap-4 mb-2 shrink-0">
        <Button ref={backRef} variant="ghost" size="sm" onClick={onClose} className="-ml-2 shrink-0">
          <ArrowLeft /> Back to explanation
        </Button>
        <p className="text-xs text-muted-foreground truncate" title={slide.title}>
          Explore · {slide.title}
        </p>
      </div>
      <div className="w-full max-w-[1600px] mx-auto flex-1 min-h-0 flex flex-col">
        <h1 className="font-serif text-xl leading-tight mb-1 shrink-0">
          {artifact?.title ?? slide.explainerIdea?.title ?? slide.title}
        </h1>
        <p className="text-muted-foreground text-sm leading-snug mb-3 shrink-0">
          {artifact?.description ??
            slide.explainerIdea?.description ??
            'Explore this code with an interactive example.'}
        </p>
        {busy && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-3 py-2 border-y border-border mb-2 text-sm shrink-0"
          >
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
            <span>
              {artifact
                ? 'Refining the example and checking its controls…'
                : 'Building the example and checking its controls. This can take several minutes…'}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void window.electronAPI.cancelExplainer(req)}>
              Cancel
            </Button>
          </div>
        )}
        {error && (
          <div role="alert" className="mb-2 text-sm shrink-0">
            <p className="text-destructive mb-2">{error}</p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void generate(refinement.trim() || undefined)}
            >
              Try again
            </Button>
          </div>
        )}
        {artifact && documentState && (
          <div className="flex flex-col flex-1 min-h-0">
            <div className="flex-1 min-w-0 min-h-0 flex flex-col">
              <div className="flex flex-wrap items-center gap-1 pb-2 border-b border-border shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!ready || busy}
                  onClick={() => control(playing ? 'pause' : 'play')}
                >
                  {playing ? <Pause /> : <Play />}
                  {playing ? 'Pause' : 'Play'}
                </Button>
                <Button variant="ghost" size="sm" disabled={!ready || busy} onClick={() => control('step')}>
                  <SkipForward /> Step
                </Button>
                <Button variant="ghost" size="sm" disabled={!ready || busy} onClick={() => control('reset')}>
                  <RotateCcw /> Reset
                </Button>
                <div className="flex items-center gap-1 ml-auto">
                  <Button
                    variant={fit ? 'secondary' : 'ghost'}
                    size="sm"
                    disabled={!ready}
                    aria-pressed={fit}
                    onClick={() => {
                      setFit(true);
                      control('fit');
                    }}
                  >
                    Fit
                  </Button>
                  <Button
                    variant={!fit ? 'secondary' : 'ghost'}
                    size="sm"
                    disabled={!ready}
                    aria-pressed={!fit}
                    onClick={() => {
                      setFit(false);
                      control('actual-size');
                    }}
                  >
                    Full size
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={detailsOpen}
                    aria-controls="explainer-details"
                    onClick={() => setDetailsOpen((open) => !open)}
                  >
                    Details & refine
                  </Button>
                </div>
              </div>
              {runtimeError && (
                <div role="alert" className="py-4 text-sm">
                  <p className="text-destructive mb-2">{runtimeError}</p>
                  <Button variant="outline" size="sm" onClick={() => setReload((n) => n + 1)}>
                    Reload view
                  </Button>
                </div>
              )}
              <iframe
                ref={frameRef}
                key={documentState.token}
                title={artifact.title}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                srcDoc={documentState.html}
                className="w-full border-0 flex-1 min-h-[180px]"
              />
            </div>
            {detailsOpen && (
              <div
                id="explainer-details"
                className="shrink-0 max-h-[40%] overflow-y-auto border-t border-border py-3 grid gap-6 lg:grid-cols-[minmax(240px,1fr)_2fr]"
              >
                <form
                  className="min-w-0"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (refinement.trim()) void generate(refinement.trim());
                  }}
                >
                  <label htmlFor="explainer-refinement" className="text-sm font-medium block mb-2">
                    Try another scenario
                  </label>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <textarea
                      id="explainer-refinement"
                      value={refinement}
                      onChange={(e) => setRefinement(e.target.value)}
                      maxLength={2000}
                      rows={2}
                      disabled={busy}
                      placeholder="Show two requests arriving together, or add a timeout…"
                      className="flex-1 min-w-0 resize-y bg-background border border-border rounded-md p-3 text-sm focus-visible:outline-[var(--ring)]"
                    />
                    <Button type="submit" variant="outline" disabled={busy || !refinement.trim()} className="self-end">
                      Refine <ArrowUpRight />
                    </Button>
                  </div>
                  {!/data-motion-id/.test(artifact.html + artifact.javascript) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      className="mt-2 -ml-2"
                      onClick={() => {
                        const instruction =
                          'Add meaningful animated transitions to this example. Preserve its teaching point, source-backed behavior, controls, and compact layout. Use stable data-motion-id groups so the host can move the same logical items between states, animate additions and removals, and highlight the current event. Keep each shape and its label together. Leave enough time between events to read the caption.';
                        setRefinement(instruction);
                        void generate(instruction);
                      }}
                    >
                      Add animated transitions
                    </Button>
                  )}
                  <p className="text-xs text-muted-foreground mt-2">
                    Refining generates a new version. Your current example stays available if it fails.
                  </p>
                </form>
                <aside className="min-w-0 grid gap-5 md:grid-cols-2" aria-label="Explanation evidence">
                  <div>
                    <h2 className="font-serif text-xl mb-3">Assumptions</h2>
                    <ul className="list-disc pl-4 text-sm leading-relaxed space-y-2 text-muted-foreground">
                      {artifact.assumptions.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h2 className="font-serif text-xl mb-3">In the code</h2>
                    <div className="space-y-4">
                      {artifact.sources.map((s, i) => (
                        <div key={i}>
                          <button
                            type="button"
                            onClick={() => setSource(source === s.filePath ? null : s.filePath)}
                            aria-expanded={source === s.filePath}
                            className="text-left font-mono text-xs break-all underline decoration-dotted underline-offset-4 hover:text-primary focus-visible:outline-[var(--ring)]"
                          >
                            {s.filePath}
                          </button>
                          <p className="text-sm text-muted-foreground leading-relaxed mt-1">{s.explanation}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                  {source && (
                    <div>
                      <h3 className="font-mono text-xs break-all mb-2">{source}</h3>
                      <pre
                        tabIndex={0}
                        className="max-h-[480px] overflow-auto text-xs bg-muted/30 p-3 rounded border border-border"
                      >
                        {slide.diffHunks
                          .filter((h) => h.filePath === source)
                          .map((h) => h.hunkHeader + '\n' + h.content)
                          .join('\n\n')}
                      </pre>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Built from this review’s saved code. The controls were checked for execution errors; use the source
                    to assess the model’s accuracy.
                  </p>
                </aside>
              </div>
            )}
          </div>
        )}
        {!artifact && !busy && !error && (
          <p className="text-muted-foreground">Select Try again to build this example.</p>
        )}
      </div>
    </section>
  );
}
