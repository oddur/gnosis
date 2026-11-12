import { ArrowRight, Code2, X } from 'lucide-react';
import { Button } from './ui/button';
import type { DiagramExploration } from '../lib/diagram-exploration';
import type { MechanismEvidence } from '../lib/mechanism';
import './diagram-explorer.css';

/** Details for the selected diagram part. Kept apart from the explorer, so xyflow loads only when it opens. */
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
