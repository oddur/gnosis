import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ReactFlow, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import { Focus, Minus, Plus } from 'lucide-react';
import { Button } from './ui/button';
import type { DiagramEntityBounds, DiagramExploration } from '../lib/diagram-exploration';
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
