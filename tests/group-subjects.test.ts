import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSubjects, type GroupingOverride, type ReviewMember, type ReviewSubject, type StackEdge } from '../lib/workbench';
import { assertPerf, perfBudget } from './perf-budget';

/** The grouping before #345 made it linear, kept to check the new one returns the same subjects. */
function quadraticGroupSubjects(members: ReviewMember[], overrides: GroupingOverride[] = [], previous: ReviewSubject[] = []): ReviewSubject[] {
  const byUrl = new Map(members.map((m) => [m.url, m]));
  const edges: StackEdge[] = [];
  const warnings = new Map<string, string[]>();
  const warn = (url: string, text: string) => warnings.set(url, [...(warnings.get(url) ?? []), text]);
  for (const child of members) {
    const candidates = members.filter((p) => p.url !== child.url && p.headRepo === child.baseRepo && p.headBranch === child.baseBranch);
    if (candidates.length === 1) edges.push({ parent: candidates[0].url, child: child.url, evidence: 'branch' });
    else if (candidates.length > 1) warn(child.url, 'Multiple possible parents. Confirm the stack relationship.');
  }
  for (const old of previous)
    for (const edge of old.edges) {
      const parent = byUrl.get(edge.parent);
      if (parent?.merged && byUrl.has(edge.child) && !edges.some((e) => e.child === edge.child)) edges.push(edge);
    }
  for (const override of overrides) {
    for (let i = edges.length - 1; i >= 0; i--) {
      if (edges[i].child === override.child && (override.action === 'link' || edges[i].parent === override.parent)) edges.splice(i, 1);
    }
    if (override.action === 'link' && byUrl.has(override.parent) && byUrl.has(override.child) && override.parent !== override.child)
      edges.push({ parent: override.parent, child: override.child, evidence: 'manual' });
  }
  const result: ReviewSubject[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.url)) continue;
    const component = new Set([member.url]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const edge of edges)
        if (component.has(edge.parent) || component.has(edge.child)) {
          for (const url of [edge.parent, edge.child])
            if (!component.has(url)) {
              component.add(url);
              changed = true;
            }
        }
    }
    const relevant = edges.filter((e) => component.has(e.parent) && component.has(e.child));
    const ordered: ReviewMember[] = [];
    const pending = new Set(component);
    while (pending.size) {
      const ready = [...pending].filter((url) => !relevant.some((e) => e.child === url && pending.has(e.parent))).sort();
      if (!ready.length) break;
      for (const url of ready) {
        const item = byUrl.get(url);
        if (item) ordered.push(item);
        pending.delete(url);
      }
    }
    if (pending.size) {
      for (const url of component) {
        const m = byUrl.get(url);
        if (!m) continue;
        result.push({ id: m.url, kind: 'pr', title: m.title, members: [m], edges: [], warnings: ['Conflicting stack dependencies. Correct the grouping before reviewing together.'] });
        seen.add(url);
      }
      continue;
    }
    const old = previous
      .filter((p) => p.kind === 'stack' && !result.some((s) => s.id === p.id) && p.members.some((m) => component.has(m.url)))
      .sort((a, b) => b.members.filter((m) => component.has(m.url)).length - a.members.filter((m) => component.has(m.url)).length)
      .at(0);
    const stack = ordered.length > 1 || (!!old && old.members.filter((m) => byUrl.has(m.url)).length === 1);
    const id = stack ? (old?.id ?? `stack:${ordered[0].url}`) : ordered[0].url;
    const uniqueId = result.some((s) => s.id === id) ? `stack:${ordered[0].url}` : id;
    result.push({
      id: uniqueId,
      kind: stack ? 'stack' : 'pr',
      title: stack && old?.name ? old.name : ordered[0].title,
      ...(stack && old?.name ? { name: old.name } : {}),
      members: ordered,
      edges: relevant,
      warnings: ordered.flatMap((m) => warnings.get(m.url) ?? []),
    });
    for (const url of component) seen.add(url);
  }
  return result;
}

/** A deterministic generator, so a failure names a reproducible seed. */
function random(seed: number) {
  let state = seed >>> 0 || 1;
  return (n: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % n;
  };
}
const member = (n: number, base: string, head: string, repo = 'o/r', merged = false): ReviewMember => ({
  number: n, repo, baseRepo: repo, headRepo: repo, url: `https://github.com/${repo}/pull/${n}`, title: `PR ${n}`, description: '',
  author: 'a', role: 'watched', baseBranch: base, headBranch: head, baseSha: 'b', headSha: `h${n}`, merged, state: merged ? 'closed' : 'open',
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', labels: [], mergeable: null, isDraft: false, commitCount: 1,
  requestedReviewers: [], requestedTeams: [], mergeableState: null, autoMerge: null, milestone: null,
});

void test('linear grouping returns exactly what the quadratic grouping returned', () => {
  const covered = { cycles: 0, ambiguous: 0, named: 0, deep: 0, manual: 0 };
  for (let seed = 1; seed <= 400; seed++) {
    const pick = random(seed);
    const count = 1 + pick(40);
    const branches = Array.from({ length: 2 + pick(12) }, (_, i) => (i === 0 ? 'main' : `b${i}`));
    const members = Array.from({ length: count }, (_, i) =>
      member(i + 1, branches[pick(branches.length)], branches[1 + pick(branches.length - 1)] ?? 'x', pick(5) ? 'o/r' : 'o/s', !pick(6)));
    // Duplicate URLs, as a merge of saved and fresh members can hold.
    if (!pick(4) && members.length > 1) members.push({ ...members[pick(members.length)], title: 'Duplicate' });
    const urls = members.map((m) => m.url);
    const overrides: GroupingOverride[] = Array.from({ length: pick(4) }, () => ({
      parent: urls[pick(urls.length)], child: urls[pick(urls.length)], action: pick(2) ? 'link' : 'unlink',
    }));
    // Earlier groupings, renamed and regrouped, keep their identity; their merged parents keep their children.
    const previous = quadraticGroupSubjects(
      members.map((m) => (pick(3) ? m : { ...m, baseBranch: branches[pick(branches.length)] })),
      overrides.slice(0, pick(overrides.length + 1))
    ).map((subject) => (subject.kind === 'stack' && pick(2) ? { ...subject, name: `Named ${subject.id}` } : subject));
    if (!pick(3)) previous.push({ id: 'stack:old', kind: 'stack', title: 'Old', name: 'Old', members: members.slice(0, 2), edges: [], warnings: [] });
    const expected = quadraticGroupSubjects(members, overrides, previous);
    assert.deepEqual(groupSubjects(members, overrides, previous), expected, `seed ${seed}`);
    for (const subject of expected) {
      if (subject.warnings.some((text) => text.startsWith('Conflicting'))) covered.cycles++;
      if (subject.warnings.some((text) => text.startsWith('Multiple'))) covered.ambiguous++;
      if (subject.name) covered.named++;
      if (subject.kind === 'stack' && subject.members.length > 2) covered.deep++;
      if (subject.edges.some((edge) => edge.evidence === 'manual')) covered.manual++;
    }
  }
  assert.ok(Object.values(covered).every((n) => n > 0), `The cases cover each rule: ${JSON.stringify(covered)}`);
});

void test('grouping a queue of 4,000 PRs with stacks is fast enough to repeat after each discovery batch', () => {
  // A few hundred stacks of up to five PRs across 20 repositories, plus many PRs on main.
  const members: ReviewMember[] = [];
  for (let n = 1; n <= 4000; n++) {
    const repo = `o/r${n % 20}`;
    const depth = n % 5;
    members.push(member(n, depth && n > 20 ? `s${n - 20}` : 'main', `s${n}`, repo, n % 97 === 0));
  }
  const first = groupSubjects(members);
  assert.ok(first.some((subject) => subject.kind === 'stack' && subject.members.length >= 4), 'The fixture has deep stacks');
  const started = performance.now();
  const again = groupSubjects([...members], [], first);
  const elapsed = performance.now() - started;
  assert.deepEqual(again.map((subject) => subject.id), first.map((subject) => subject.id), 'Regrouping keeps every identity');
  // Before #345 this took about 600 ms on a fast Mac.
  assertPerf('regrouping 4,000 PRs', elapsed, perfBudget(60));
});
