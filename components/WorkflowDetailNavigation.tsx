import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Button } from './ui/button';

export interface WorkflowRelation {
  id: string;
  name: string;
  label: string;
  outside?: boolean;
}

export function WorkflowDetailNavigation({
  count,
  position,
  onMove,
  prerequisites,
  dependants,
  onReveal,
  onClose,
}: {
  count: number;
  position: number;
  onMove: (direction: 1 | -1) => void;
  prerequisites: WorkflowRelation[];
  dependants: WorkflowRelation[];
  onReveal: (id: string) => void;
  onClose: () => void;
}) {
  const summary = [
    prerequisites.length ? `Needs: ${prerequisites.map((n) => n.name).join(', ')}` : 'No mapped prerequisites',
    dependants.length ? `Feeds: ${dependants.map((n) => n.name).join(', ')}` : 'No mapped dependants',
  ].join(' · ');
  return (
    <div
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <nav className="workflow-issue-navigation" aria-label="Navigate workflow issues">
        <Button size="sm" variant="ghost" aria-label="Previous issue" disabled={!count} onClick={() => onMove(-1)}>
          <ArrowLeft size={14} /> Previous
        </Button>
        <span role="status">
          {position >= 0
            ? `Issue ${position + 1} of ${count}`
            : count
              ? `${count} ${count === 1 ? 'issue' : 'issues'} in view`
              : 'No issues in view'}
        </span>
        <Button size="sm" variant="ghost" aria-label="Next issue" disabled={!count} onClick={() => onMove(1)}>
          Next <ArrowRight size={14} />
        </Button>
      </nav>
      <details className="workflow-detail-relations">
        <summary title={summary}>{summary}</summary>
        {(
          [
            ['Prerequisites', prerequisites],
            ['Dependants', dependants],
          ] as const
        ).map(([label, relations]) => (
          <div key={label}>
            <strong>{label}</strong>
            {relations.length ? (
              <ul>
                {relations.map((n) => (
                  <li key={n.id}>
                    <span>
                      {n.name} · {n.label}
                      {n.outside ? ' · Outside this view' : ''}
                    </span>
                    {n.outside && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onReveal(n.id)}
                        aria-label={`Reveal prerequisite ${n.name}`}
                      >
                        Reveal
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p>None mapped in this workflow.</p>
            )}
          </div>
        ))}
      </details>
    </div>
  );
}
