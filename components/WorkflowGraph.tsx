import { WorkflowViewMenu } from './WorkflowViewMenu';
import { WorkflowDetailNavigation } from './WorkflowDetailNavigation';
import { createPortal } from 'react-dom';
import {
  attentionJobs,
  nextAttentionJob,
  preferredWorkflow,
  prChecksHint,
  workflowRunLabel,
  workflowSession,
} from '../lib/workflow-navigation';
import { readableWorkflowViewport } from '../lib/workflow-viewport';
import { workflowEdgePath } from '../lib/workflow-edge-path';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  useUpdateNodeInternals,
  BaseEdge,
  type EdgeProps,
  Handle,
  Position,
  Controls,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Focus,
  Network,
  ArrowRight,
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
  workflowGrouping,
  type WorkflowGrouping,
  type WorkflowGraph as Graph,
  type WorkflowGraphNode,
  type WorkflowRuns,
  type WorkflowJob,
} from '../lib/workflow-graph';
import { SearchableSelect } from './SearchableSelect';
import { Button } from './ui/button';
import { timeAgo } from '../lib/utils';

let rememberedGrouping: WorkflowGrouping | undefined;

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
    emphasized: boolean;
    selected: boolean;
    now: number;
    prerequisite?: string;
    outsidePrerequisite?: string;
    onRevealPrerequisite: () => void;
    onOpen: () => void;
    onExpand: () => void;
    onFocusDependencies: () => void;
    onHighlight: (active: boolean, input: 'pointer' | 'focus') => void;
  },
  'job'
>;
function JobCard({ id, data }: NodeProps<JobNode>) {
  const { item } = data;
  const updateNodeInternals = useUpdateNodeInternals();
  const portSignature = item.ports?.map((port) => `${port.id}:${port.y}`).join('|');
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, portSignature, updateNodeInternals]);
  const { group, label, Icon } = outcome(item.jobs);
  const active = item.jobs.flatMap((job) => job.steps).find((step) => step.status === 'in_progress');
  const stageCounts = item.stage
    ? [
        [item.jobs.filter((j) => j.status !== 'completed').length, 'active'],
        [item.jobs.filter((j) => j.status === 'completed' && j.conclusion === 'success').length, 'passed'],
        [
          item.jobs.filter(
            (j) => j.status === 'completed' && (j.conclusion === 'skipped' || j.conclusion === 'neutral')
          ).length,
          'skipped / neutral',
        ],
        [item.stage.unreported, 'not reported'],
      ]
        .filter(([count]) => Number(count) > 0)
        .map(([count, text]) => `${count} ${text}`)
        .join(' · ')
    : undefined;
  const secondary = item.stage
    ? stageCounts && stageCounts !== label
      ? stageCounts
      : 'Expand to inspect jobs'
    : item.unmapped
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
      data-stage={!!item.stage || undefined}
      data-collapsed={item.collapsed || undefined}
      data-dim={data.dim || undefined}
      data-emphasized={data.emphasized || undefined}
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
        disabled={!item.jobs.length && !item.expandable && !item.collapsed}
        aria-label={item.collapsed ? `${item.name}: Show ${item.collapsed} jobs` : `${item.name}: ${label}`}
        title={
          item.collapsed
            ? `${item.unmapped ? 'Dependency mapping unavailable\n' : ''}${item.jobs.map((job) => job.name).join('\n')}\nClick to show ${item.collapsed} jobs`
            : item.stage
              ? item.stage.names.join('\n')
              : item.name
        }
      >
        <span className="workflow-job-name">
          {item.collapsed && (group === 'attention' || group === 'running') ? `${label} · Show jobs` : item.name}
        </span>
        {item.collapsed && <Plus size={14} aria-hidden="true" />}
        {!item.collapsed && (
          <span className={`workflow-job-state check-${group}`}>
            <Icon size={15} className={label === 'Running' ? 'animate-spin' : undefined} />
            <span>{label}</span>
            <span className="workflow-job-duration">
              {item.jobs.length === 1 ? checkDuration(item.jobs[0], data.now) : ''}
            </span>
          </span>
        )}
        {!item.collapsed && secondary && !data.outsidePrerequisite && (
          <span className="workflow-job-context" title={secondary}>
            {secondary}
          </span>
        )}
      </button>
      {data.outsidePrerequisite && (
        <button
          className="workflow-outside-prerequisite nodrag"
          onClick={data.onRevealPrerequisite}
          title={`Failed prerequisite outside this view: ${data.outsidePrerequisite}. Reveal in workflow.`}
          aria-label={`Reveal failed prerequisite outside this view: ${data.outsidePrerequisite}`}
        >
          Failed outside view: {data.outsidePrerequisite}
        </button>
      )}
      {!item.collapsed && (
        <button
          className="workflow-focus nodrag"
          onClick={data.onFocusDependencies}
          aria-label={`Show dependencies for ${item.name}`}
          title="Show this job, its prerequisites, and dependants"
        >
          <Network size={14} />
        </button>
      )}
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
  onExternalChecks,
  onFilterChange,
  active = true,
  stateKey,
  detailHost,
  toolbarHost,
  onRevealContext,
}: {
  subject: ReviewSubject;
  active?: boolean;
  stateKey: string;
  detailHost?: HTMLElement | null;
  toolbarHost?: HTMLElement | null;
  onRevealContext: () => void;
  onExternalChecks: (url: string) => void;
  onFilterChange: (value: CheckFilter) => void;
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
  const session = useMemo(() => workflowSession(stateKey), [stateKey]);
  const [memberUrl, setMemberUrl] = useState(
    session.memberUrl ??
      subject.members.find((m) => values[m.url]?.checks.some((c) => checkGroup(c) === 'attention'))?.url ??
      subject.members.at(0)?.url ??
      ''
  );
  const member = subject.members.find((m) => m.url === memberUrl) ?? subject.members.at(0);
  const snapshot = member && values[member.url];
  const sha = snapshot?.headSha ?? member?.headSha;
  const scope = `${member?.url}@${sha}`;
  const [runsState, setRuns] = useState<{ scope: string; value: WorkflowRuns }>();
  const [runId, setRunId] = useState<number | undefined>(session.runId);
  const runs = runsState?.scope === scope ? runsState.value : undefined;
  const run = runs?.runs.find((r) => r.id === runId) ?? runs?.runs[0];
  const [expanded, setExpanded] = useState<string[]>(session.expanded);
  const [grouping, setGrouping] = useState<WorkflowGrouping>(rememberedGrouping ?? 'adaptive');
  const [groupingReady, setGroupingReady] = useState(rememberedGrouping !== undefined);
  const [preferenceError, setPreferenceError] = useState('');
  const preferenceWrites = useRef(Promise.resolve());
  const preferenceEdited = useRef(false);
  useEffect(() => {
    if (rememberedGrouping !== undefined) return;
    let live = true;
    void window.electronAPI
      .loadPreferences()
      .then((prefs) => {
        if (!live || preferenceEdited.current) return;
        rememberedGrouping = workflowGrouping(prefs.workflowGrouping);
        setGrouping(rememberedGrouping);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setGroupingReady(true);
      });
    return () => {
      live = false;
    };
  }, []);
  function chooseGrouping(value: string) {
    const next = workflowGrouping(value);
    preferenceEdited.current = true;
    rememberedGrouping = next;
    setGrouping(next);
    setFocusNodeId(undefined);
    setPreferenceError('');
    preferenceWrites.current = preferenceWrites.current
      .catch(() => {})
      .then(async () => {
        const prefs = await window.electronAPI.loadPreferences();
        await window.electronAPI.savePreferences({ ...prefs, workflowGrouping: next });
      })
      .catch(() => setPreferenceError('Could not save grouping. Your choice is kept for this session.'));
  }
  const [showSkipped, setShowSkipped] = useState(session.showSkipped);
  const [showCompleted, setShowCompleted] = useState(session.showCompleted);
  const [focusNodeId, setFocusNodeId] = useState<string | undefined>(session.focusNodeId);
  const [navigationNodeId, setNavigationNodeId] = useState<string>();
  useEffect(() => {
    Object.assign(session, { memberUrl, runId, expanded, showSkipped, showCompleted, focusNodeId });
  }, [session, memberUrl, runId, expanded, showSkipped, showCompleted, focusNodeId]);
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
  const previousGraphKey = useRef(graphKey);
  useEffect(() => {
    if (previousGraphKey.current !== graphKey && previousGraphKey.current.split(':').at(-1) !== 'undefined')
      setFocusNodeId(undefined);
    setNavigationNodeId(undefined);
    previousGraphKey.current = graphKey;
  }, [graphKey]);
  useEffect(() => {
    setHovered(undefined);
    setFocused(undefined);
  }, [graphKey, showSkipped, showCompleted]);
  const expansions = expanded.join('|');
  const observedAt = snapshot?.checkedAt;
  useEffect(() => {
    if (!active || !member || !sha) return;
    let live = true;
    const target = { url: member.url, headSha: sha };
    const force = requests.current.runs !== refreshNonce || requests.current.retry !== retry;
    requests.current.runs = refreshNonce;
    requests.current.retry = retry;
    setLoadingRuns(true);
    setRunError('');
    const apply = (value?: WorkflowRuns) => {
      if (live && value) {
        setRuns({ scope, value });
        setRunId((current) => (value.runs.some((r) => r.id === current) ? current : preferredWorkflow(value.runs)?.id));
      }
    };
    void (async () => {
      const saved = await window.electronAPI.getWorkflowRuns(target, { cachedOnly: true });
      apply(saved);
      apply(await window.electronAPI.getWorkflowRuns(target, { force, background: !force && !!saved }));
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
  }, [scope, observedAt, refreshNonce, retry, active]);
  const viewKey = JSON.stringify([expansions, showSkipped, showCompleted, focusNodeId, grouping]);
  const requestedView = {
    graphKey,
    viewKey,
    input: {
      url: member?.url ?? '',
      headSha: sha ?? '',
      runId: run?.id ?? 0,
      expanded,
      grouping,
      showSkipped,
      showCompleted,
      focusNodeId,
    },
  };
  const latestView = useRef(requestedView);
  latestView.current = requestedView;
  const applyGraph = (value: Graph | undefined, request: typeof requestedView) => {
    if (
      !value ||
      !run ||
      value.run.attempt < run.attempt ||
      request.graphKey !== latestView.current.graphKey ||
      request.viewKey !== latestView.current.viewKey
    )
      return;
    if (value.run.attempt > run.attempt)
      setRuns((current) =>
        current?.scope === scope
          ? {
              ...current,
              value: { ...current.value, runs: current.value.runs.map((r) => (r.id === value.run.id ? value.run : r)) },
            }
          : current
      );
    const key = `${scope}:${value.run.id}:${value.run.attempt}`;
    setGraph((current) =>
      current?.key === key && current.value.checkedAt > value.checkedAt ? current : { key, value }
    );
  };
  // Network refresh follows check freshness and explicit refresh, never canvas navigation.
  useEffect(() => {
    if (!active || !member || !sha || !run || !groupingReady) return;
    const lifecycle = new AbortController();
    const isLive = () => !lifecycle.signal.aborted;
    const request = latestView.current;
    const force = requests.current.graph !== refreshNonce || requests.current.graphRetry !== retry;
    requests.current.graphRetry = retry;
    requests.current.graph = refreshNonce;
    setLoadingGraph(true);
    setGraphError('');
    void (async () => {
      const saved = await window.electronAPI.getWorkflowGraph(request.input, { cachedOnly: true });
      if (isLive()) applyGraph(saved, request);
      const fresh = await window.electronAPI.getWorkflowGraph(request.input, { force, background: !force && !!saved });
      if (!isLive()) return;
      const current = latestView.current;
      if (request.viewKey === current.viewKey) applyGraph(fresh, request);
      else {
        // Navigation during refresh must get the fresh results in the currently requested view.
        const projected = await window.electronAPI.getWorkflowGraph(current.input, { cachedOnly: true });
        if (isLive()) applyGraph(projected, current);
      }
    })()
      .catch((e: unknown) => {
        if (isLive()) setGraphError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (isLive()) setLoadingGraph(false);
      });
    return () => {
      lifecycle.abort();
    };
  }, [graphKey, runs?.checkedAt, refreshNonce, retry, groupingReady, active]);
  const previousProjection = useRef(requestedView);
  useEffect(() => {
    const previous = previousProjection.current;
    const request = latestView.current;
    previousProjection.current = request;
    if (!active || previous.graphKey !== request.graphKey || previous.viewKey === request.viewKey || !run) return;
    let live = true;
    setGraphError('');
    void window.electronAPI
      .getWorkflowGraph(request.input, { cachedOnly: true })
      .then((value) => {
        if (!live) return;
        if (value) applyGraph(value, request);
        else setGraphError('Saved workflow data is unavailable. Retry workflow to load it again.');
      })
      .catch((e: unknown) => {
        if (live) setGraphError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [graphKey, viewKey, active]);
  const [now, setNow] = useState(Date.now);
  const running = graph?.nodes.some((n) => n.jobs.some((j) => j.status === 'in_progress'));
  useEffect(() => {
    if (!active || !running) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [running, active]);
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
  const selectedNode = graph?.nodes.find((node) => selectedId && node.jobs.some((job) => job.checkId === selectedId));
  const initialAnchor = useRef<{ key: string; id?: string } | undefined>(undefined);
  if (graph && initialAnchor.current?.key !== graphKey)
    initialAnchor.current = {
      key: graphKey,
      id:
        attentionJobs(graph.nodes)[0]?.node.id ??
        graph.nodes.find((n) => n.jobs.some((j) => j.status !== 'completed'))?.id,
    };
  const anchorId =
    (graph?.nodes.some((n) => n.id === navigationNodeId) ? navigationNodeId : undefined) ??
    selectedNode?.id ??
    (graph?.focus ? undefined : initialAnchor.current?.id);
  const anchor = graph?.nodes.find((n) => n.id === anchorId);
  const viewportGraph =
    graph && !graph.focus && anchor ? { ...graph, focus: { id: anchor.id, name: anchor.name } } : graph;
  const topology = graph?.nodes.map((n) => `${n.id}:${n.x}:${n.y}`).join('|');
  const viewportKey = `${graphKey}:${topology}:${graph?.focus?.id ?? ''}`;
  const fitted = useRef('');
  const canvasBounds = () => {
    const bounds = canvas.current?.getBoundingClientRect();
    const detail = canvas.current?.closest('.checks-panes')?.querySelector<HTMLElement>('.check-detail:not([hidden])');
    if (!bounds) return;
    const overlay = detail && getComputedStyle(detail).position === 'absolute';
    const width =
      overlay && detail.getBoundingClientRect().width < bounds.width
        ? Math.max(268, bounds.width - detail.getBoundingClientRect().width)
        : bounds.width;
    return { width, height: bounds.height };
  };
  useEffect(() => {
    if (!active || !flow || !graph || !topology) return;
    const key = `${viewportKey}:${canvasSize}:${anchorId ?? ''}`;
    if (fitted.current === key) return;
    const timer = setTimeout(() => {
      const bounds = canvasBounds();
      if (!bounds?.width || !bounds.height) return;
      const restore = !fitted.current && session.viewportKey === viewportKey && session.viewport;
      void flow.setViewport(restore || readableWorkflowViewport(viewportGraph ?? graph, bounds.width, bounds.height));
      fitted.current = key;
    }, 100);
    return () => clearTimeout(timer);
  }, [flow, topology, graphKey, canvasSize, anchorId, graph?.focus?.id, active]);
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
  const outsideJobs = (item: Pick<WorkflowGraphNode, 'jobs'>) =>
    item.jobs.map((job) => {
      const check = snapshot?.checks.find((c) => c.id === job.checkId);
      return check && snapshot && graph && snapshot.checkedAt > graph.checkedAt
        ? { ...job, status: check.status, conclusion: check.conclusion }
        : job;
    });
  const outsideFailures = new Map(
    displayed.map((node) => [
      node.id,
      node.outsidePrerequisites?.filter((n) => outcome(outsideJobs(n)).group === 'attention') ?? [],
    ])
  );
  const revealPrerequisite = (id: string) => {
    setFocusNodeId(undefined);
    setNavigationNodeId(id);
    setHovered(undefined);
    setFocused(undefined);
    if (detailHost) onRevealContext();
  };
  const failureSources = new Map<string, string>();
  // Explain the prerequisite fact, not a guessed cause for skips (if/always may override it).
  for (const edge of graph?.edges ?? []) {
    const source = byId.get(edge.source);
    if (source && outcome(source.jobs).group === 'attention') failureSources.set(edge.target, source.name);
  }
  const toggle = (id: string) => {
    if (focusNodeId === id) setFocusNodeId(undefined);
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
    height: item.height ?? 112,
    measured: { width: 244, height: item.height ?? 112 },
    data: {
      item,
      now,
      prerequisite: failureSources.get(item.id),
      outsidePrerequisite: outsideFailures
        .get(item.id)
        ?.map((n) => n.name)
        .join(', '),
      onRevealPrerequisite: () => {
        const first = outsideFailures.get(item.id)?.at(0);
        if (first) revealPrerequisite(first.id);
      },
      selected: !!selectedId && item.jobs.some((j) => j.checkId === selectedId),
      emphasized:
        (!!highlight && related.has(item.id)) ||
        (filter === 'attention' && !!attentionJobs([item]).length) ||
        (filter === 'running' && item.jobs.some((job) => job.status !== 'completed')),
      dim:
        (filter === 'attention' && !attentionJobs([item]).length) ||
        (filter === 'running' && !item.jobs.some((job) => job.status !== 'completed')) ||
        (!!highlight && !related.has(item.id)),
      onHighlight: (active, input) =>
        (input === 'pointer' ? setHovered : setFocused)((current) =>
          active ? item.id : current === item.id ? undefined : current
        ),
      onExpand: () => toggle(item.id),
      onFocusDependencies: () => {
        setFocusNodeId(item.id);
        setHovered(undefined);
        setFocused(undefined);
      },
      onOpen: () => {
        setNavigationNodeId(undefined);
        if (item.collapsed) {
          if (item.collapsed === 'skipped') setShowSkipped(true);
          else setShowCompleted(true);
          return;
        }
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
  const issues = attentionJobs(displayed);
  const activeCount = new Set(displayed.flatMap((n) => n.jobs.filter((j) => j.status !== 'completed').map((j) => j.id)))
    .size;
  const navigateIssue = (open: boolean, direction: 1 | -1 = 1) => {
    const target = open ? nextAttentionJob(issues, selectedId, direction) : issues.at(0);
    if (!target || !graph || !snapshot) return;
    setNavigationNodeId(target.node.id);
    if (open) {
      if (target.node.expandable)
        setExpanded((current) => (current.includes(target.node.id) ? current : [...current, target.node.id]));
      const check = workflowJobCheck(target.job, snapshot.checks);
      if (check) onSelect(snapshot, check);
    }
  };
  const edges = (graph?.edges ?? []).map((edge) => ({
    ...edge,
    ariaLabel: `${byId.get(edge.target)?.name ?? edge.target} requires ${byId.get(edge.source)?.name ?? edge.source}`,
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
  const toolbarControls = (
    <>
      <div className="workflow-selectors">
        {subject.members.length > 1 && (
          <SearchableSelect
            label="PR for workflow graph"
            value={member?.url ?? ''}
            options={subject.members.map((m) => ({
              value: m.url,
              label: `#${m.number} · ${prChecksHint(values[m.url])} · ${m.title}`,
            }))}
            onValueChange={(value) => {
              onContextChange();
              setMemberUrl(value);
              setRunId(undefined);
              setExpanded([]);
              setFocusNodeId(undefined);
            }}
          />
        )}
        {!!runs?.runs.length && (
          <SearchableSelect
            label="Workflow"
            value={String(run?.id ?? '')}
            options={runs.runs.map((r) => ({ value: String(r.id), label: workflowRunLabel(r) }))}
            onValueChange={(value) => {
              onContextChange();
              setRunId(Number(value));
              setExpanded([]);
              setFocusNodeId(undefined);
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
        {graph && (
          <WorkflowViewMenu
            grouping={grouping}
            onGrouping={chooseGrouping}
            showSkipped={showSkipped}
            onSkipped={setShowSkipped}
            showCompleted={showCompleted}
            onCompleted={setShowCompleted}
            grouped={graph.nodes.filter((n) => n.stage).reduce((sum, n) => sum + n.jobs.length, 0)}
          >
            <span>
              {run?.sha.slice(0, 7)} · {graph.totalJobs ?? graph.nodes.flatMap((n) => n.jobs).length} jobs
            </span>
            {graph.definitionUrl && (
              <a href={graph.definitionUrl} target="_blank" rel="noopener noreferrer">
                Workflow source <ExternalLink size={12} />
              </a>
            )}
          </WorkflowViewMenu>
        )}
      </div>
      {graph && (
        <div className="workflow-triage">
          <div role="group" aria-label="Highlight jobs in this workflow">
            <Button
              size="sm"
              variant={filter === 'all' ? 'secondary' : 'ghost'}
              aria-pressed={filter === 'all'}
              onClick={() => onFilterChange('all')}
            >
              All jobs
            </Button>
            <Button
              size="sm"
              variant={filter === 'attention' ? 'secondary' : 'ghost'}
              aria-pressed={filter === 'attention'}
              onClick={() => {
                onFilterChange('attention');
                navigateIssue(false);
              }}
            >
              Needs attention ({issues.length})
            </Button>
            <Button
              size="sm"
              variant={filter === 'running' ? 'secondary' : 'ghost'}
              aria-pressed={filter === 'running'}
              onClick={() => {
                onFilterChange('running');
                setNavigationNodeId(displayed.find((n) => n.jobs.some((j) => j.status !== 'completed'))?.id);
              }}
            >
              Running ({activeCount})
            </Button>
          </div>

          {!!issues.length && (
            <Button
              size="sm"
              variant={issues.length ? 'outline' : 'ghost'}
              disabled={!issues.length}
              onClick={() => navigateIssue(true)}
            >
              Next issue <ArrowRight size={14} />
            </Button>
          )}
          {!!snapshot?.checks.some((c) => c.kind === 'status') && (
            <Button size="sm" variant="ghost" onClick={() => member && onExternalChecks(member.url)}>
              External checks ({snapshot.checks.filter((c) => c.kind === 'status').length})
            </Button>
          )}
        </div>
      )}
      <span
        className="workflow-updating"
        role="status"
        title={
          loadingRuns || loadingGraph
            ? 'Updating workflow'
            : graph
              ? `Checked ${timeAgo(new Date(graph.checkedAt).toISOString())}`
              : undefined
        }
      >
        {loadingRuns || loadingGraph ? (
          <>
            <LoaderCircle size={13} className="animate-spin" /> <span>Updating</span>
          </>
        ) : graph ? (
          <>
            <Clock3 size={13} aria-hidden="true" />
            <span>Checked {timeAgo(new Date(graph.checkedAt).toISOString())}</span>
          </>
        ) : (
          ''
        )}
      </span>
    </>
  );
  return (
    <section className="workflow-graph-view" aria-label="Workflow dependency graph">
      {detailHost &&
        createPortal(
          <WorkflowDetailNavigation
            count={issues.length}
            position={issues.findIndex((i) => i.job.checkId === selectedId)}
            onMove={(direction) => navigateIssue(true, direction)}
            onReveal={revealPrerequisite}
            onClose={onRevealContext}
            prerequisites={[
              ...(
                graph?.edges.filter((e) => e.target === selectedNode?.id).flatMap((e) => byId.get(e.source) ?? []) ?? []
              ).map((n) => ({ id: n.id, name: n.name, label: outcome(n.jobs).label })),
              ...(selectedNode?.outsidePrerequisites ?? []).map((n) => ({
                id: n.id,
                name: n.name,
                label: outcome(outsideJobs(n)).label,
                outside: true,
              })),
            ]}
            dependants={(
              graph?.edges.filter((e) => e.source === selectedNode?.id).flatMap((e) => byId.get(e.target) ?? []) ?? []
            ).map((n) => ({ id: n.id, name: n.name, label: outcome(n.jobs).label }))}
          />,
          detailHost
        )}
      {toolbarHost ? createPortal(toolbarControls, toolbarHost) : toolbarControls}
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
      <span
        className={
          [...outsideFailures.values()].some((items) => items.length)
            ? 'workflow-scope-status workflow-context-notice'
            : 'sr-only workflow-scope-status'
        }
        role="status"
      >
        {filter === 'running' && !activeCount
          ? 'No active jobs in this view'
          : [...outsideFailures.values()].some((items) => items.length)
            ? 'Failed prerequisites outside this view'
            : issues.length
              ? ''
              : 'No jobs need attention in this view'}
      </span>
      {preferenceError && (
        <div className="workflow-notice" role="status">
          {preferenceError}
        </div>
      )}
      {graph?.focus && (
        <div className="workflow-navigation">
          <Button variant="outline" size="sm" onClick={() => setFocusNodeId(undefined)}>
            Back to workflow
          </Button>
          <span role="status">Prerequisites and dependants of {graph.focus.name}</span>
        </div>
      )}
      {graph && !graph.focus && expanded.length > 0 && (
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
        {graph && (
          <div className="workflow-viewport-actions" role="group" aria-label="Graph zoom">
            <Button
              variant="outline"
              size="sm"
              title="Readable size"
              aria-label="Readable size"
              onClick={() => {
                const bounds = canvasBounds();
                if (flow && bounds)
                  void flow.setViewport(readableWorkflowViewport(viewportGraph ?? graph, bounds.width, bounds.height));
              }}
            >
              <Focus size={16} />
              <span className="sr-only">Readable size</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              title="Fit entire workflow"
              aria-label="Fit entire workflow"
              onClick={() => void flow?.fitView({ padding: 0.15, minZoom: 0.1, maxZoom: 1 })}
            >
              <Expand size={16} />
              <span className="sr-only">Fit entire workflow</span>
            </Button>
          </div>
        )}

        {graph?.nodes.length ? (
          <ReactFlow<JobNode>
            key={graphKey}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={setFlow}
            onMoveEnd={(_event, viewport) => {
              session.viewport = viewport;
              session.viewportKey = viewportKey;
            }}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            minZoom={0.1}
            maxZoom={1.5}
            panOnScroll
            preventScrolling
            aria-label="CI job dependencies"
          >
            <Controls showInteractive={false} showFitView={false} />
            <MiniMap
              pannable
              zoomable
              ariaLabel="Workflow map. Drag to navigate."
              nodeColor={(node) => {
                const group = outcome(byId.get(node.id)?.jobs ?? []).group;
                return group === 'attention'
                  ? 'var(--color-danger)'
                  : group === 'running'
                    ? 'var(--color-warning)'
                    : 'var(--muted-foreground)';
              }}
              maskColor="color-mix(in srgb, var(--background) 75%, transparent)"
              style={{ width: 120, height: 72, background: 'var(--card)', border: '1px solid var(--border)' }}
            />
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
