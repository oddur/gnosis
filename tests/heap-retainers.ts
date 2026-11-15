/**
 * Debug helper for browser checks: what keeps detached DOM alive. Parses a V8 heap snapshot, finds the shortest
 * path from the GC roots to each detached element, and counts the distinct paths. Used by --interaction-perf with
 * GNOSIS_HEAP_RETAINERS=1.
 */
interface Snapshot {
  locations?: number[];
  snapshot: { meta: { node_fields: string[]; node_types: [string[]]; edge_fields: string[]; edge_types: [string[]] } };
  nodes: number[];
  edges: number[];
  strings: string[];
}

export function detachedRetainers(json: string, samples = 400, top = 8): string[] {
  const snap = JSON.parse(json) as Snapshot;
  const { meta } = snap.snapshot;
  const nodeFieldCount = meta.node_fields.length;
  const edgeFieldCount = meta.edge_fields.length;
  const nameField = meta.node_fields.indexOf('name');
  const typeField = meta.node_fields.indexOf('type');
  const edgeCountField = meta.node_fields.indexOf('edge_count');
  const detachField = meta.node_fields.indexOf('detachedness');
  const edgeTypeField = meta.edge_fields.indexOf('type');
  const edgeNameField = meta.edge_fields.indexOf('name_or_index');
  const edgeToField = meta.edge_fields.indexOf('to_node');
  const nodeTypes = meta.node_types[0];
  const edgeTypes = meta.edge_types[0];
  const count = snap.nodes.length / nodeFieldCount;
  const firstEdge = new Uint32Array(count + 1);
  for (let i = 0, e = 0; i < count; i++) {
    firstEdge[i] = e;
    e += snap.nodes[i * nodeFieldCount + edgeCountField] * edgeFieldCount;
  }
  firstEdge[count] = snap.edges.length;
  const parent = new Int32Array(count).fill(-1);
  const parentEdge = new Int32Array(count).fill(-1);
  const seen = new Uint8Array(count);
  const queue = new Uint32Array(count);
  let head = 0, tail = 0;
  queue[tail++] = 0;
  seen[0] = 1;
  while (head < tail) {
    const node = queue[head++];
    for (let e = firstEdge[node]; e < firstEdge[node + 1]; e += edgeFieldCount) {
      const type = edgeTypes[snap.edges[e + edgeTypeField]];
      if (type === 'weak' || type === 'shortcut') continue;
      const to = snap.edges[e + edgeToField] / nodeFieldCount;
      if (seen[to]) continue;
      seen[to] = 1;
      parent[to] = node;
      parentEdge[to] = e;
      queue[tail++] = to;
    }
  }
  const name = (node: number) => snap.strings[snap.nodes[node * nodeFieldCount + nameField]];
  const type = (node: number) => nodeTypes[snap.nodes[node * nodeFieldCount + typeField]];
  const edgeName = (e: number) => {
    const t = edgeTypes[snap.edges[e + edgeTypeField]];
    const n = snap.edges[e + edgeNameField];
    return t === 'element' || t === 'hidden' ? `[${n}]` : snap.strings[n];
  };
  // Script positions of closures, so a retaining timer callback names its source.
  const where = new Map<number, string>();
  const locations = snap.locations ?? [];
  for (let i = 0; i + 3 < locations.length; i += 4) where.set(locations[i] / nodeFieldCount, `@${locations[i + 1]}:${locations[i + 2] + 1}:${locations[i + 3]}`);
  const paths = new Map<string, number>();
  let taken = 0;
  for (let node = 0; node < count && taken < samples; node++) {
    const detached = detachField >= 0 ? snap.nodes[node * nodeFieldCount + detachField] === 2 : name(node).startsWith('Detached');
    if (!detached || type(node) !== 'native' || parent[node] < 0) continue;
    taken++;
    const hops: string[] = [];
    for (let at = node; parent[at] >= 0 && hops.length < 40; at = parent[at]) {
      const from = parent[at];
      hops.push(`${type(from) === 'closure' ? `fn ${name(from) || '(anonymous)'}${where.get(from) ?? ''}` : name(from).slice(0, 50)}.${edgeName(parentEdge[at])}`);
    }
    // From the root outward, keeping the hops that name app code, not React internals.
    const path = hops.reverse().slice(0, 16).join(' > ');
    paths.set(path, (paths.get(path) ?? 0) + 1);
  }
  return [...paths].sort((a, b) => b[1] - a[1]).slice(0, top).map(([path, n]) => `${n}x ${path}`);
}
