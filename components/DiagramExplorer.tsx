import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ReactFlow, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import { ArrowRight, Code2, Focus, Minus, Plus, X } from 'lucide-react';
import { Button } from './ui/button';
import type { DiagramEntityBounds, DiagramExploration } from '../lib/diagram-exploration';
import type { MechanismEvidence } from '../lib/mechanism';
import '@xyflow/react/dist/style.css';
import './diagram-explorer.css';

type DrawingNode = Node<{ drawing: ReactNode }, 'drawing'>;
type EntityNode = Node<{ label: string; active: boolean; select: () => void }, 'entity'>;
type DiagramNode = DrawingNode | EntityNode;
function Drawing({ data }: NodeProps<DrawingNode>) {
  return <div className="diagram-explorer-drawing">{data.drawing}</div>;
}
function Entity({ data }: NodeProps<EntityNode>) {
  return (
    <button
      className="diagram-entity-target nodrag"
      aria-label={`Inspect ${data.label}`}
      aria-pressed={data.active}
      onClick={data.select}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          data.select();
        }
      }}
    />
  );
}
const nodeTypes = { drawing: Drawing, entity: Entity };

export function DiagramExplorer({
  drawing,
  width,
  height,
  bounds,
  exploration,
  selected,
  onSelect,
}: {
  drawing: ReactNode;
  width: number;
  height: number;
  bounds: DiagramEntityBounds[];
  exploration: DiagramExploration;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [flow, setFlow] = useState<ReactFlowInstance<DiagramNode>>();
  const canvas = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!flow || !canvas.current) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void flow.fitView({ padding: 0.12, maxZoom: 1.5 }));
    });
    observer.observe(canvas.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [flow]);
  const nodes = useMemo<DiagramNode[]>(
    () => [
      {
        id: '__drawing',
        type: 'drawing',
        position: { x: 0, y: 0 },
        data: { drawing },
        width,
        height,
        measured: { width, height },
        style: { width, height },
        selectable: false,
        focusable: false,
      },
      ...bounds.flatMap((b): EntityNode[] => {
        const entity = exploration.entities.find((e) => e.id === b.id);
        if (!entity || ![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0)
          return [];
        return [
          {
            id: b.id,
            type: 'entity',
            position: { x: b.x, y: b.y },
            width: b.width,
            height: b.height,
            measured: { width: b.width, height: b.height },
            style: { width: b.width, height: b.height },
            focusable: false,
            data: { label: entity.label, active: selected === b.id, select: () => onSelect(b.id) },
          },
        ];
      }),
    ],
    [drawing, width, height, bounds, exploration, selected, onSelect]
  );
  return (
    <div className="diagram-explorer-canvas" aria-label="Explorable diagram">
      <div ref={canvas} className="diagram-explorer-viewport">
        <ReactFlow<DiagramNode>
          nodes={nodes}
          edges={[]}
          nodeTypes={nodeTypes}
          onInit={setFlow}
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 1.5 }}
          minZoom={0.35}
          maxZoom={3}
          elementsSelectable={false}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          panOnScroll={false}
          onPaneClick={() => onSelect(null)}
          proOptions={{ hideAttribution: true }}
        />
      </div>
      <div className="diagram-explorer-tools" role="group" aria-label="Diagram viewport">
        <Button size="icon" variant="ghost" aria-label="Zoom out" onClick={() => void flow?.zoomOut()}>
          <Minus size={16} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Fit diagram"
          onClick={() => void flow?.fitView({ padding: 0.12, maxZoom: 1.5 })}
        >
          <Focus size={16} />
        </Button>
        <Button size="icon" variant="ghost" aria-label="Zoom in" onClick={() => void flow?.zoomIn()}>
          <Plus size={16} />
        </Button>
      </div>
    </div>
  );
}

export function DiagramInspector({
  exploration,
  selected,
  onSelect,
  onShowCode,
  canShowCode,
  compact = false,
}: {
  exploration: DiagramExploration;
  selected: string | null;
  onSelect: (id: string | null) => void;
  canShowCode?: (evidence: MechanismEvidence) => boolean;
  onShowCode?: (evidence: MechanismEvidence) => void;
  compact?: boolean;
}) {
  const entity = exploration.entities.find((e) => e.id === selected);
  const relationship = exploration.relationships.find((r) => r.id === selected);
  const item = entity ?? relationship;
  const name = (id: string) => exploration.entities.find((e) => e.id === id)?.label ?? id;
  const connections = entity ? exploration.relationships.filter((r) => r.from === entity.id || r.to === entity.id) : [];
  if (!item && compact) return <p className="diagram-explorer-hint">Select a component or connection to inspect it.</p>;
  return (
    <aside className={`diagram-inspector${compact ? ' diagram-inspector-compact' : ''}`} aria-label="Diagram details">
      {item ? (
        <>
          <div className="diagram-inspector-heading">
            <h3>{item.label}</h3>
            <Button variant="ghost" size="icon" aria-label="Clear diagram selection" onClick={() => onSelect(null)}>
              <X size={16} />
            </Button>
          </div>
          {entity && (
            <span className="diagram-change-label">
              {entity.change === 'changed' ? 'Changed in this review' : 'Existing context'}
            </span>
          )}
          {relationship && (
            <p className="diagram-relationship-endpoints">
              {name(relationship.from)} <ArrowRight size={14} aria-hidden="true" /> {name(relationship.to)}
            </p>
          )}
          <p className="diagram-inspector-summary">{item.summary}</p>
          {item.evidence && (
            <div className="diagram-source">
              {onShowCode && canShowCode?.(item.evidence) ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (item.evidence) onShowCode(item.evidence);
                  }}
                >
                  <Code2 size={15} />
                  Show code
                </Button>
              ) : (
                <span className="text-muted-foreground">Source reference</span>
              )}
              <code>
                {item.evidence.filePath}:{item.evidence.startLine}
              </code>
            </div>
          )}
          {connections.length > 0 && (
            <div className="diagram-connections">
              <h4>Direct connections</h4>
              {connections.map((r) => (
                <button key={r.id} aria-label={`Inspect connection: ${r.label}`} onClick={() => onSelect(r.id)}>
                  <span>{r.label}</span>
                  <small>
                    {name(r.from)} → {name(r.to)}
                  </small>
                </button>
              ))}
            </div>
          )}
          {relationship && (
            <div className="diagram-connections">
              <h4>Components</h4>
              {[...new Set([relationship.from, relationship.to])].map((id) => (
                <button key={id} onClick={() => onSelect(id)}>
                  {name(id)}
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <h3>Explore the change</h3>
          <p className="diagram-inspector-summary">Select a component to see its role, connections, and source.</p>
          <div className="diagram-component-list">
            {exploration.entities.map((e) => (
              <button key={e.id} onClick={() => onSelect(e.id)}>
                <span>{e.label}</span>
                <small>{e.change === 'changed' ? 'Changed' : 'Context'}</small>
              </button>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
