/** 0 active, 1 visible, 2 unread, 3 current view. */
export type OpenTier = 0 | 1 | 2 | 3;
/** A queue PR whose status, checks and discussions are saved ahead of opening. */
export interface OpenTarget {
  url: string;
  headSha: string;
  baseSha: string;
  updatedAt: string;
  tier: OpenTier;
}
type Member = Omit<OpenTarget, 'tier'>;
export interface OpenRows {
  /** Every target, in tier order, then queue order. */
  targets: OpenTarget[];
  /** Queue row ID to its PRs, at most five. */
  rows: Map<string, OpenTarget[]>;
}

/** Ranks queue rows by preparation intent. PRs outside every tier are not preloaded. */
export function openRows(
  subjects: { id: string; members: Member[] }[],
  intent: { active?: string[]; visible?: string[]; unread?: string[]; view?: string[] }
): OpenRows {
  const tiers = new Map<string, OpenTier>();
  ([intent.active, intent.visible, intent.unread, intent.view] as const).forEach((urls, tier) => {
    for (const url of urls ?? []) if (!tiers.has(url)) tiers.set(url, tier as OpenTier);
  });
  const byUrl = new Map<string, OpenTarget>();
  const rows = new Map<string, OpenTarget[]>();
  for (const subject of subjects) {
    if (rows.has(subject.id)) continue;
    const members: OpenTarget[] = [];
    for (const member of subject.members) {
      const tier = tiers.get(member.url);
      // Local reviews and incomplete discovery records have nothing to preload.
      if (tier === undefined || !valid({ ...member, tier })) continue;
      const target = byUrl.get(member.url) ?? {
        url: member.url,
        headSha: member.headSha,
        baseSha: member.baseSha,
        updatedAt: member.updatedAt,
        tier,
      };
      byUrl.set(member.url, target);
      members.push(target);
    }
    rows.set(subject.id, members.slice(0, 5));
  }
  const order = [...byUrl.values()];
  return { targets: order.map((target, index) => ({ target, index }))
    .sort((a, b) => a.target.tier - b.target.tier || a.index - b.index)
    .map(({ target }) => target), rows };
}

const sha = /^[a-f\d]{40}$/i;
const prUrl = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/;
function valid(input: Record<string, unknown>): boolean {
  return (
    typeof input.url === 'string' &&
    prUrl.test(input.url) &&
    typeof input.headSha === 'string' &&
    sha.test(input.headSha) &&
    typeof input.baseSha === 'string' &&
    sha.test(input.baseSha) &&
    typeof input.updatedAt === 'string' &&
    input.updatedAt.length <= 40 &&
    Number.isFinite(Date.parse(input.updatedAt)) &&
    [0, 1, 2, 3].includes(input.tier as number)
  );
}
/** Validates renderer input. Returns undefined for anything malformed or over the limit. */
export function parseOpenTargets(value: unknown, limit: number): OpenTarget[] | undefined {
  if (!Array.isArray(value) || value.length > limit) return;
  const targets: OpenTarget[] = [];
  for (const raw of value as unknown[]) {
    if (!raw || typeof raw !== 'object' || !valid(raw as Record<string, unknown>)) return;
    const input = raw as OpenTarget;
    targets.push({ url: input.url, headSha: input.headSha, baseSha: input.baseSha, updatedAt: input.updatedAt, tier: input.tier });
  }
  return targets;
}
