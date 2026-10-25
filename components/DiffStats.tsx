/** Shared semantic colors also used by Pierre's shadow-DOM file tree. */
export const DIFF_STAT_COLORS = {
  added: 'var(--color-success)',
  removed: 'var(--color-danger)',
};

export function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="diff-stats">
      <span style={{ color: DIFF_STAT_COLORS.added }}>+{additions}</span>
      <span style={{ color: DIFF_STAT_COLORS.removed }}>−{deletions}</span>
    </span>
  );
}
