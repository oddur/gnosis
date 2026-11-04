import { workflowEdgePath } from '../lib/workflow-edge-path';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  BaseEdge,
  type EdgeProps,
  Handle,
  Position,
  Controls,
  MarkerType,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  Clock3,
  Expand,
  ExternalLink,
  LoaderCircle,
  Minus,
  Plus,
} from 'lucide-react';
import type { ReviewSubject } from '../lib/workbench';
import { checkDuration, checkGroup, checkLabel, type PrChecks, type PrCheck, type CheckFilter } from '../lib/pr-checks';
import {
  workflowJobCheck,
  type WorkflowGraph as Graph,
  type WorkflowGraphNode,
  type WorkflowRuns,
  type WorkflowJob,
} from '../lib/workflow-graph';
import { SearchableSelect } from './SearchableSelect';
import { Button } from './ui/button';
import { timeAgo } from '../lib/utils';

function outcome(jobs: WorkflowJob[]) {
  if (!jobs.length) return { group: 'unknown', label: 'Not reported', Icon: Circle };
  const counts = { attention: 0, running: 0, passed: 0, skipped: 0 };
  for (const job of jobs)
    counts[
      checkGroup({
        ...job,
        status: job.status === 'completed' ? 'completed' : job.status === 'in_progress' ? 'in_progress' : 'queued',
      })
    ]++;
  if (counts.attention)
    return {
      group: 'attention',
      label:
        jobs.length === 1
          ? checkLabel({ ...jobs[0], status: 'completed' })
          : `${counts.attention} ${counts.attention === 1 ? 'needs' : 'need'} attention`,
      Icon: CircleAlert,
    };
  if (counts.running)
    return {
      group: 'running',
      label: jobs.some((j) => j.status === 'in_progress') ? 'Running' : 'Queued',
      Icon: jobs.some((j) => j.status === 'in_progress') ? LoaderCircle : Clock3,
    };
  if (counts.passed)
    return { group: 'passed', label: jobs.length === 1 ? 'Passed' : `${counts.passed} passed`, Icon: CircleCheck };
  return {
    group: 'skipped',
    label: jobs.length === 1 ? checkLabel({ ...jobs[0], status: 'completed' }) : `${counts.skipped} skipped / neutral`,
    Icon: CircleMinus,
  };
}
type JobNode = Node<
  {
    item: WorkflowGraphNode;
    dim: boolean;
    selected: boolean;
    now: number;
    prerequisite?: string;
    onOpen: () => void;
    onExpand: () => void;
    onHighlight: (active: boolean, input: 'pointer' | 'focus') => void;
  },
  'job'
>;
function JobCard({ data }: NodeProps<JobNode>) {
  const { item } = data;
  const { group, label, Icon } = outcome(item.jobs);
  const active = item.jobs.flatMap((job) => job.steps).find((step) => step.status === 'in_progress');
  const secondary = item.unmapped
    ? 'Dependency mapping unavailable'
    : data.prerequisite
      ? `Prerequisite failed: ${data.prerequisite}`
      : item.jobs.length > 1
        ? `${item.jobs.length} jobs${item.jobs.some((j) => j.status !== 'completed') ? ` · ${item.jobs.filter((j) => j.status !== 'completed').length} running or queued` : ''}`
        : active
          ? active.name
          : item.group !== item.name
            ? item.group
            : undefined;
  return (
    <div
      className="workflow-job"
      data-dim={data.dim || undefined}
      data-selected={data.selected || undefined}
      data-outcome={group}
      onMouseEnter={() => data.onHighlight(true, 'pointer')}
      onMouseLeave={() => data.onHighlight(false, 'pointer')}
      onFocus={() => data.onHighlight(true, 'focus')}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) data.onHighlight(false, 'focus');
      }}
    >
      {item.ports?.map((port) => (
        <Handle
          key={port.id}
          id={port.id}
          type={port.type}
          position={port.type === 'source' ? Position.Right : Position.Left}
          style={{ top: port.y }}
          isConnectable={false}
        />
      ))}
      <button
        className="workflow-job-open nodrag"
        onClick={data.onOpen}
        disabled={!item.jobs.length && !item.expandable}
        aria-label={`${item.name}: ${label}`}
        title={item.name}
      >
        <span className="workflow-job-name">{item.name}</span>
        <span className={`workflow-job-state check-${group}`}>
          <Icon size={15} className={label === 'Running' ? 'animate-spin' : undefined} />
          <span>{label}</span>
          <span className="workflow-job-duration">
            {item.jobs.length === 1 ? checkDuration(item.jobs[0], data.now) : ''}
          </span>
        </span>
        {secondary && (
          <span className="workflow-job-context" title={secondary}>
            {secondary}
          </span>
        )}
      </button>
      {item.expandable && (
        <button
          className="workflow-expand nodrag"
          onClick={data.onExpand}
          aria-label={`Expand ${item.name}`}
          title={`Expand ${item.name}`}
        >
          <Plus size={14} />
        </button>
      )}
    </div>
  );
}
const nodeTypes = { job: JobCard };
function RoutedEdge({ id, data, markerEnd, style }: EdgeProps) {
  const points = data?.points as { x: number; y: number }[] | undefined;
  return points?.length ? (
    <BaseEdge id={id} path={workflowEdgePath(points)} markerEnd={markerEnd} style={style} />
  ) : null;
}
const edgeTypes = { routed: RoutedEdge };

export function WorkflowGraphView({
  subject,
  values,
  filter,
  refreshNonce,
  selectedId,
  onSelect,
  onContextChange,
}: {
  subject: ReviewSubject;
  values: Partial<Record<string, PrChecks>>;
  filter: CheckFilter;
  refreshNonce: number;
  selectedId?: string;
  onSelect: (snapshot: PrChecks, check: PrCheck) => void;
  onContextChange: () => void;
}) {
  const [hovered, setHovered] = useState<string>();
  const [focused, setFocused] = useState<string>();
  const highlight = hovered ?? focused;
  const [memberUrl, setMemberUrl] = useState(subject.members.at(0)?.url ?? '');
  const member = subject.members.find((m) => m.url === memberUrl) ?? subject.members.at(0);
  const snapshot = member && values[member.url];
  const sha = snapshot?.headSha ?? member?.headSha;
  const scope = `${member?.url}@${sha}`;
  const [runsState, setRuns] = useState<{ scope: string; value: WorkflowRuns }>();
  const [runId, setRunId] = useState<number>();
  const runs = runsState?.scope === scope ? runsState.value : undefined;
  const run = runs?.runs.find((r) => r.id === runId) ?? runs?.runs[0];
  const [expanded, setExpanded] = useState<string[]>([]);
  const [graphState, setGraph] = useState<{ key: string; value: Graph }>();
  const [runError, setRunError] = useState('');
  const [graphError, setGraphError] = useState('');
  const error = runError || graphError;
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingGraph, setLoadingGraph] = useState(false);
  const [retry, setRetry] = useState(0);
  const requests = useRef({ runs: refreshNonce, graph: refreshNonce, retry: 0, graphRetry: 0 });
  const graphKey = `${scope}:${run?.id}:${run?.attempt}`;
  const graph = graphState?.key === graphKey ? graphState.value : undefined;
  useEffect(() => {
    setHovered(undefined);
    setFocused(undefined);
  }, [graphKey]);
  const expansions = expanded.join('|');
  const observedAt = snapshot?.checkedAt;
  useEffect(() => {
    if (!member || !sha) return;
    let live = true;
    const target = { url: member.url, headSha: sha };
    const force = requests.current.runs !== refreshNonce || requests.current.retry !== retry;
    requests.current.runs = refreshNonce;
    requests.current.retry = retry;
    setLoadingRuns(true);
    setRunError('');
    const apply = (value?: WorkflowRuns) => {
      if (live && value) setRuns({ scope, value });
    };
    void (async () => {
      apply(await window.electronAPI.getWorkflowRuns(target, { cachedOnly: true }));
      apply(await window.electronAPI.getWorkflowRuns(target, { force, background: !force }));
    })()
      .catch((e: unknown) => {
        if (live) setRunError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setLoadingRuns(false);
      });
    return () => {
      live = false;
    };
  }, [scope, observedAt, refreshNonce, retry]);
  useEffect(() => {
    if (!member || !sha || !run) return;
    let live = true;
    const input = { url: member.url, headSha: sha, runId: run.id, expanded };
    const force = requests.current.graph !== refreshNonce || requests.current.graphRetry !== retry;
    requests.current.graphRetry = retry;
    requests.current.graph = refreshNonce;
    setLoadingGraph(true);
    setGraphError('');
    const apply = (value?: Graph) => {
      if (!live || !value || value.run.attempt < run.attempt) return;
      if (value.run.attempt > run.attempt)
        setRuns((current) =>
          current?.scope === scope
            ? {
                ...current,
                value: {
                  ...current.value,
                  runs: current.value.runs.map((r) => (r.id === value.run.id ? value.run : r)),
                },
              }
            : current
        );
      setGraph({ key: `${scope}:${value.run.id}:${value.run.attempt}`, value });
    };
    void (async () => {
      apply(await window.electronAPI.getWorkflowGraph(input, { cachedOnly: true }));
      apply(await window.electronAPI.getWorkflowGraph(input, { force, background: !force }));
    })()
      .catch((e: unknown) => {
        if (live) setGraphError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setLoadingGraph(false);
      });
    return () => {
      live = false;
    };
  }, [graphKey, expansions, runs?.checkedAt, refreshNonce, retry]);
  const [now, setNow] = useState(Date.now);
  const running = graph?.nodes.some((n) => n.jobs.some((j) => j.status === 'in_progress'));
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [running]);
  const canvas = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState('');
  useEffect(() => {
    if (!canvas.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0)
        setCanvasSize(`${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`);
    });
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);
  const [flow, setFlow] = useState<ReactFlowInstance<JobNode>>();
  const topology = graph?.nodes.map((n) => `${n.id}:${n.x}:${n.y}`).join('|');
  const fitted = useRef('');
  useEffect(() => {
    if (!flow || !graph || !topology) return;
    const key = `${graphKey}:${topology}:${canvasSize}`;
    if (fitted.current === key) return;
    const timer = setTimeout(() => {
      void flow.fitView({ padding: 0.15, maxZoom: 1, minZoom: 0.35 });
      fitted.current = key;
    }, 100);
    return () => clearTimeout(timer);
  }, [flow, topology, graphKey, canvasSize]);
  const displayed = useMemo(
    () =>
      graph?.nodes.map((n) => ({
        ...n,
        jobs: n.jobs.map((job) => {
          const check = snapshot?.checks.find((c) => c.id === job.checkId);
          return check && snapshot && snapshot.checkedAt > graph.checkedAt
            ? {
                ...job,
                status: check.status,
                conclusion: check.conclusion,
                startedAt: check.startedAt,
                completedAt: check.completedAt,
              }
            : job;
        }),
      })) ?? [],
    [graph, snapshot]
  );
  const byId = new Map(displayed.map((n) => [n.id, n]));
  const failureSources = new Map<string, string>();
  // Explain the prerequisite fact, not a guessed cause for skips (if/always may override it).
  for (const edge of graph?.edges ?? []) {
    const source = byId.get(edge.source);
    if (source && outcome(source.jobs).group === 'attention') failureSources.set(edge.target, source.name);
  }
  const toggle = (id: string) => {
    setHovered(undefined);
    setFocused(undefined);
    setExpanded((current) => (current.includes(id) ? current.filter((v) => v !== id) : [...current, id]));
  };
  const related = new Set(highlight ? [highlight] : []);
  for (const edge of graph?.edges ?? [])
    if (edge.source === highlight || edge.target === highlight) {
      related.add(edge.source);
      related.add(edge.target);
    }
  const nodes: JobNode[] = displayed.map((item) => ({
    id: item.id,
    type: 'job',
    position: { x: item.x, y: item.y },
    draggable: false,
    width: 244,
    height: 112,
    measured: { width: 244, height: 112 },
    data: {
      item,
      now,
      prerequisite: failureSources.get(item.id),
      selected: item.jobs.some((j) => j.checkId === selectedId),
      dim: (filter !== 'all' && outcome(item.jobs).group !== filter) || (!!highlight && !related.has(item.id)),
      onHighlight: (active, input) =>
        (input === 'pointer' ? setHovered : setFocused)((current) =>
          active ? item.id : current === item.id ? undefined : current
        ),
      onExpand: () => toggle(item.id),
      onOpen: () => {
        if (item.expandable) {
          toggle(item.id);
          return;
        }
        const job = item.jobs.at(0);
        if (!job || !snapshot || !graph) return;
        const check = workflowJobCheck(job, snapshot.checks);
        if (check) onSelect(snapshot, check);
      },
    },
  }));
  const edges = (graph?.edges ?? []).map((edge) => ({
    ...edge,
    type: 'routed',
    sourceHandle: `source:${edge.id}`,
    targetHandle: `target:${edge.id}`,
    data: { points: edge.points },
    style: highlight
      ? edge.source === highlight || edge.target === highlight
        ? { stroke: 'var(--ring)', strokeWidth: 2, opacity: 1 }
        : { opacity: 0.18 }
      : undefined,
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    className:
      failureSources.has(edge.target) && outcome(byId.get(edge.source)?.jobs ?? []).group === 'attention'
        ? 'workflow-edge-failed'
        : undefined,
  }));
  return (
    <section className="workflow-graph-view" aria-label="Workflow dependency graph">
      <div className="workflow-selectors">
        {subject.members.length > 1 && (
          <SearchableSelect
            label="PR for workflow graph"
            value={member?.url ?? ''}
            options={subject.members.map((m) => ({ value: m.url, label: `#${m.number} ${m.title}` }))}
            onValueChange={(value) => {
              onContextChange();
              setMemberUrl(value);
              setRunId(undefined);
              setExpanded([]);
            }}
          />
        )}
        {!!runs?.runs.length && (
          <SearchableSelect
            label="Workflow"
            value={String(run?.id ?? '')}
            options={runs.runs.map((r) => ({ value: String(r.id), label: `${r.name} · Attempt ${r.attempt}` }))}
            onValueChange={(value) => {
              onContextChange();
              setRunId(Number(value));
              setExpanded([]);
            }}
          />
        )}
        {run && (
          <a
            href={run.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open workflow on GitHub"
            aria-label="Open workflow on GitHub"
          >
            <ExternalLink size={15} />
          </a>
        )}
        <span className="workflow-updating" role="status">
          {loadingRuns || loadingGraph ? (
            <>
              <LoaderCircle size={13} className="animate-spin" /> Updating
            </>
          ) : graph ? (
            `Checked ${timeAgo(new Date(graph.checkedAt).toISOString())}`
          ) : (
            ''
          )}
        </span>
      </div>
      {error && (
        <div className="workflow-notice" role="status">
          {graph ? 'Showing saved workflow. ' : ''}
          {error}{' '}
          <Button variant="ghost" size="sm" onClick={() => setRetry((n) => n + 1)}>
            Retry workflow
          </Button>
        </div>
      )}
      {runs?.warning && <p className="workflow-notice">{runs.warning}</p>}
      {graph?.warnings.length ? (
        <details className="workflow-notice">
          <summary>Some dependencies are unavailable</summary>
          {graph.warnings.map((warning, i) => (
            <p key={i}>{warning}</p>
          ))}
        </details>
      ) : null}
      {graph && (
        <div className="workflow-context">
          <span>
            {run?.sha.slice(0, 7)} · {graph.nodes.flatMap((n) => n.jobs).length} jobs
          </span>
          <span>Arrows follow workflow prerequisites</span>
          {snapshot?.checks.some((c) => c.kind === 'status') && <span>External checks are in List</span>}
          {graph.definitionUrl && (
            <a href={graph.definitionUrl} target="_blank" rel="noopener noreferrer">
              Workflow source <ExternalLink size={12} />
            </a>
          )}
        </div>
      )}
      {graph && expanded.length > 0 && (
        <div className="workflow-expanded-groups" aria-label="Expanded job groups">
          {graph.groups
            .filter((g) => expanded.includes(g.id))
            .map((g) => (
              <Button key={g.id} size="sm" variant="ghost" onClick={() => toggle(g.id)}>
                <Minus size={13} /> Collapse {g.name}
              </Button>
            ))}
        </div>
      )}
      <div className="workflow-canvas" ref={canvas}>
        {graph?.nodes.length ? (
          <ReactFlow<JobNode>
            key={graphKey}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={setFlow}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            minZoom={0.2}
            maxZoom={1.5}
            panOnScroll
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
            preventScrolling
            aria-label="CI job dependencies"
          >
            <Controls showInteractive={false} />
          </ReactFlow>
        ) : (
          <div className="checks-empty">
            <Expand size={24} />
            <h2>{loadingRuns || loadingGraph ? 'Loading workflow graph…' : 'No workflow jobs reported'}</h2>
            <p>
              {loadingRuns || loadingGraph
                ? 'Reading jobs and their workflow definitions.'
                : 'GitHub Actions workflows appear here. External checks remain available in List view.'}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
