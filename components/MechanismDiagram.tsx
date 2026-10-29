import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, Pause, Play, RotateCcw } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { mechanismFrame, normalizeMechanism, type MechanismEvidence, type MechanismScene } from '../lib/mechanism';
import { layoutMechanism, NODE_WIDTH, pointOnRoute } from '../lib/mechanism-layout';
import './mechanism-diagram.css';

// Measure the actual font; wrapping happens only when content/fonts change, not each animation tick.
function wrap(text: string, width: number, font: string) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return [text];
  context.font = font;
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && context.measureText(`${line} ${word}`).width > width) {
      lines.push(line);
      line = '';
    }
    if (context.measureText(word).width > width) {
      for (const char of word) {
        if (context.measureText(line + char).width > width) {
          lines.push(line);
          line = '';
        }
        line += char;
      }
    } else line += `${line ? ' ' : ''}${word}`;
  }
  if (line) lines.push(line);
  return lines;
}
function Label({
  text,
  x,
  y,
  width,
  size = 18,
  weight = 400,
}: {
  text: string;
  x: number;
  y: number;
  width: number;
  size?: number;
  weight?: number;
}) {
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void document.fonts.ready.then(() => {
      if (alive) setFontReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  const lines = useMemo(
    () => wrap(text, width, `${weight} ${size}px "Plus Jakarta Sans", sans-serif`),
    [text, width, size, weight, fontReady]
  );
  return (
    <text x={x} y={y} fontSize={size} fontWeight={weight}>
      {lines.map((line, i) => (
        <tspan key={i} x={x} dy={i ? size * 1.25 : 0}>
          {line}
        </tspan>
      ))}
    </text>
  );
}
function EdgeLabel({ text, x, y, width }: { text: string; x: number; y: number; width: number }) {
  const lines = useMemo(() => wrap(text, width, '400 14px "Plus Jakarta Sans", sans-serif'), [text, width]);
  return (
    <text x={x} y={y - (lines.length - 1) * 17} textAnchor="middle" fontSize="14" className="mechanism-edge-label">
      {lines.map((line, i) => (
        <tspan key={i} x={x} dy={i ? 17 : 0}>
          {line}
        </tspan>
      ))}
    </text>
  );
}
export function MechanismDiagram({
  scene,
  expanded,
  onExpandedChange,
  canShowCode,
  onShowCode,
}: {
  scene: MechanismScene;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  canShowCode?: (source: MechanismEvidence) => boolean;
  onShowCode?: (source: MechanismEvidence) => void;
}) {
  const safe = useMemo(() => normalizeMechanism(scene), [scene]);
  if (!safe)
    return (
      <p className="text-sm text-muted-foreground">Diagram unavailable. You can still read the explanation and code.</p>
    );
  return (
    <Player
      key={JSON.stringify(safe)}
      scene={safe}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      canShowCode={canShowCode}
      onShowCode={onShowCode}
    />
  );
}
function Player({
  scene,
  expanded,
  onExpandedChange,
  canShowCode,
  onShowCode,
}: {
  scene: MechanismScene;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  canShowCode?: (source: MechanismEvidence) => boolean;
  onShowCode?: (source: MechanismEvidence) => void;
}) {
  const [scenarioIndex, setScenarioIndex] = useState(0);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [localOpen, setLocalOpen] = useState(false);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const expandButton = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLElement>(null);
  const inline = useRef<HTMLDivElement>(null);
  const inlineHeight = useRef(0);
  const [compact, setCompact] = useState(true);
  useEffect(() => {
    const observer = new ResizeObserver((entries) => setCompact(entries[0].contentRect.width < 700));
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const instance = useId().replace(/:/g, '');
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void document.fonts.ready.then(() => {
      if (alive) setFontReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  const metrics = useMemo(() => {
    const labels = Math.max(
      ...scene.nodes.map((n) => wrap(n.label, NODE_WIDTH - 28, '600 19px "Plus Jakarta Sans", sans-serif').length)
    );
    const states = scene.scenarios.flatMap((s) => s.events.flatMap((e) => e.states));
    const values = Math.max(
      ...states.map((s) => wrap(s.value, NODE_WIDTH - 28, '600 17px "Plus Jakarta Sans", sans-serif').length)
    );
    const previous = Math.max(
      ...states.map((s) => wrap(`Was: ${s.value}`, NODE_WIDTH - 28, '400 14px "Plus Jakarta Sans", sans-serif').length)
    );
    const valueY = 28 + labels * 24 + 14;
    const itemsY = valueY + (values - 1) * 22 + 18;
    const itemLines = Math.max(
      1,
      ...states.flatMap((s) =>
        (s.items ?? []).map((item) => wrap(item, 76, '400 16px "Plus Jakarta Sans", sans-serif').length)
      )
    );
    const itemHeight = itemLines * 20 + 10;
    const height = Math.max(itemsY + 2 * (itemHeight + 6) + 12, itemsY + previous * 18 + 20);
    return { valueY, itemsY, height, itemHeight };
  }, [scene, fontReady]);
  const layout = useMemo(() => layoutMechanism(scene, metrics.height, compact), [scene, metrics.height, compact]);
  const scenario = scene.scenarios[scenarioIndex];
  const last = scenario.events.length - 1;
  const frame = mechanismFrame(scenario.events, position, reduced);
  const open = expanded ?? localOpen;
  const setOpen = onExpandedChange ?? setLocalOpen;
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => {
      setReduced(mq.matches);
      setPlaying(false);
    };
    const visibility = () => {
      if (document.hidden) setPlaying(false);
    };
    mq.addEventListener('change', change);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mq.removeEventListener('change', change);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  useEffect(() => {
    if (!playing) return;
    let request = 0;
    let before = 0;
    const tick = (time: number) => {
      const delta = before ? Math.min(time - before, 100) : 0;
      before = time;
      setPosition((p) => Math.min(last, p + (delta * speed) / 3200));
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [playing, last, speed]);
  useEffect(() => {
    if (position >= last) setPlaying(false);
  }, [position, last]);
  function seek(next: number) {
    setPlaying(false);
    setPosition(Math.max(0, Math.min(last, next)));
  }
  function showCode(source: MechanismEvidence) {
    setPlaying(false);
    setOpen(false);
    requestAnimationFrame(() => onShowCode?.(source));
  }
  const source = frame.event.evidence;
  const codeAvailable = source && onShowCode && canShowCode?.(source);
  function drawing(suffix: string) {
    const marker = `mechanism-arrow-${instance}-${suffix}`;
    const transfer = frame.transfer;
    const movingEdge = transfer ? layout.edges.find((e) => e.id === transfer.edge) : undefined;
    const point = movingEdge ? pointOnRoute(movingEdge.points, frame.progress) : undefined;
    const trails = new Set(
      scenario.events.slice(0, frame.index + 1).flatMap((e) => (e.transfer ? [e.transfer.edge] : []))
    );
    return (
      <svg
        className="mechanism-scene"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={`${scene.title}. ${frame.event.title}. ${frame.event.caption}`}
      >
        <title>{scene.title}</title>
        <desc>{frame.event.caption}</desc>
        <defs>
          <marker
            id={marker}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
          </marker>
        </defs>
        {layout.edges.map((edge) => (
          <g
            key={edge.id}
            className="mechanism-edge"
            data-active={frame.event.focus.includes(edge.id) || transfer?.edge === edge.id}
            data-trace={trails.has(edge.id)}
          >
            <path d={edge.path} markerEnd={`url(#${marker})`} />
            <EdgeLabel
              text={edge.label}
              x={edge.labelPosition.x}
              y={edge.labelPosition.y - 14}
              width={edge.points.length === 2 ? 64 : 200}
            />
          </g>
        ))}
        {layout.nodes.map((node) => {
          const state = frame.event.states.find((s) => s.id === node.id);
          if (!state) return null;
          const prev = frame.index ? scenario.events[frame.index - 1].states.find((s) => s.id === node.id) : undefined;
          const changed =
            !!prev && (prev.value !== state.value || JSON.stringify(prev.items) !== JSON.stringify(state.items));
          return (
            <g
              key={node.id}
              data-node={node.id}
              transform={`translate(${node.x} ${node.y})`}
              className="mechanism-node"
              data-tone={state.tone ?? 'neutral'}
              data-focus={frame.event.focus.includes(node.id)}
            >
              <rect className="mechanism-node-body" width={NODE_WIDTH} height={metrics.height} rx="8" />
              <Label text={node.label} x={14} y={28} width={NODE_WIDTH - 28} size={19} weight={600} />
              <g className="mechanism-value" data-changed={changed}>
                <Label text={state.value} x={14} y={metrics.valueY} width={NODE_WIDTH - 28} size={17} />
              </g>
              {node.kind === 'queue' &&
                state.items?.map((item, i) => (
                  <g
                    key={`${i}-${item}`}
                    transform={`translate(${14 + (i % 2) * 100} ${metrics.itemsY + Math.floor(i / 2) * (metrics.itemHeight + 6)})`}
                  >
                    <rect className="mechanism-queue-item" width="92" height={metrics.itemHeight} rx="4" />
                    <Label text={item} x={8} y={21} width={76} size={16} />
                  </g>
                ))}
              {node.kind !== 'queue' && changed && (
                <g className="mechanism-previous">
                  <Label text={`Was: ${prev.value}`} x={14} y={metrics.itemsY + 16} width={NODE_WIDTH - 28} size={14} />
                </g>
              )}
            </g>
          );
        })}
        {point && transfer && (
          <g className="mechanism-payload" transform={`translate(${point.x} ${point.y})`}>
            <circle r="7" />
            <title>{transfer.label}</title>
            {transfer.label.length <= 8 && (
              <text y="28" textAnchor="middle" fontSize="16">
                {transfer.label}
              </text>
            )}
          </g>
        )}
      </svg>
    );
  }
  const controls = (
    <div className="mechanism-controls" role="group" aria-label="Animation playback">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Previous event"
        disabled={position === 0}
        onClick={() => seek(frame.index - 1)}
      >
        <ChevronLeft size={16} />
      </Button>
      <Button
        variant="outline"
        size="sm"
        aria-label={playing ? 'Pause animation' : 'Play animation'}
        aria-pressed={playing}
        onClick={() => {
          if (position >= last) setPosition(0);
          setPlaying(!playing);
        }}
      >
        {playing ? <Pause size={15} /> : <Play size={15} />} {playing ? 'Pause' : 'Play'}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Next event"
        disabled={frame.index >= last}
        onClick={() => seek(frame.index + 1)}
      >
        <ChevronRight size={16} />
      </Button>
      <input
        className="mechanism-scrubber"
        type="range"
        min="0"
        max={last}
        step="0.01"
        value={position}
        aria-label="Diagram timeline"
        aria-valuetext={`Event ${frame.index + 1} of ${last + 1}: ${frame.event.title}`}
        onChange={(e) => seek(Number(e.target.value))}
      />
      <label className="mechanism-speed">
        <span className="sr-only">Playback speed</span>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          <option value={0.5}>0.5×</option>
          <option value={1}>1×</option>
          <option value={2}>2×</option>
        </select>
      </label>
      <Button variant="ghost" size="icon" aria-label="Restart animation" onClick={() => seek(0)}>
        <RotateCcw size={15} />
      </Button>
    </div>
  );
  const caption = (
    <div className="mechanism-caption" aria-live={playing ? 'off' : 'polite'}>
      <div className="mechanism-event-heading">
        <span className="mechanism-event-count">
          {frame.index + 1} / {last + 1}
        </span>
        <strong>{frame.event.title}</strong>
      </div>
      <p>{frame.transfer ? `In transit: ${frame.transfer.label}. ${frame.event.caption}` : frame.event.caption}</p>
      {codeAvailable && (
        <Button variant="link" size="sm" onClick={() => showCode(source)}>
          Show supporting code
        </Button>
      )}
    </div>
  );
  const scenarios = (
    <div className="mechanism-scenarios">
      {scene.scenarios.length > 1 && (
        <label>
          Scenario{' '}
          <select
            aria-label="Diagram scenario"
            value={scenarioIndex}
            onChange={(e) => {
              setScenarioIndex(Number(e.target.value));
              seek(0);
            }}
          >
            {scene.scenarios.map((s, i) => (
              <option key={s.id} value={i}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <p>{scenario.input}</p>
    </div>
  );
  return (
    <figure ref={container} className="mechanism-diagram" aria-label={scene.title}>
      <div className="mechanism-intro">
        <p>{scene.takeaway}</p>
        <Button
          ref={expandButton}
          variant="ghost"
          size="icon"
          aria-label="Expand animation"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            setPlaying(false);
            inlineHeight.current = inline.current?.getBoundingClientRect().height ?? 0;
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
          {drawing('inline')}
          {caption}
        </div>
      )}
      <details className="mechanism-assumptions">
        <summary>About this example</summary>
        <p>{scene.assumptions}</p>
        <p>Playback shows event order, not elapsed execution time.</p>
      </details>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          setPlaying(false);
        }}
      >
        <DialogContent
          className="mechanism-dialog"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            expandButton.current?.focus({ preventScroll: true });
          }}
        >
          <DialogTitle>{scene.title}</DialogTitle>
          {open && (
            <>
              <p className="mechanism-takeaway">{scene.takeaway}</p>
              {scenarios}
              <div className="mechanism-expanded-scene">{drawing('expanded')}</div>
              {caption}
              {controls}
            </>
          )}
        </DialogContent>
      </Dialog>
    </figure>
  );
}
