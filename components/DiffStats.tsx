/** Shared semantic colors also used by Pierre's shadow-DOM file tree. */
export const DIFF_STAT_COLORS = {
  added: 'var(--color-success)',
  removed: 'var(--color-danger)',
  /**
   * A changed symbol (#394). The panel's ink, like added and removed: `--code-modified` is drawn for the dark code
   * surface, and on a light panel it is too faint to read.
   */
  modified: 'var(--color-warning)',
};

export function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="diff-stats">
      <span style={{ color: DIFF_STAT_COLORS.added }}>+{additions}</span>
      <span style={{ color: DIFF_STAT_COLORS.removed }}>−{deletions}</span>
    </span>
  );
}
