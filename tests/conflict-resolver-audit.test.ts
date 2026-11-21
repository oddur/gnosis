import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { MERGIRAF, MUTATIONS, RESOLVERS, runResolverAudit, summarize } from '../scripts/conflict-resolver-audit-core';

/**
 * The resolver audit (#445 item 19) on the lab's fixtures and one generated case per matrix pattern and language: every
 * mutation of a result that passed the checks must fail them. `npm run conflict-resolver-audit -- --all` runs the whole
 * matrix.
 */
void test(
  'no mutation of a checked resolver result ends Merged',
  { skip: !fs.existsSync(MERGIRAF) && 'Run npm run prepare:mergiraf first.' },
  async () => {
    const report = await runResolverAudit();
    assert.deepEqual(report.errors, []);
    const escaped = report.results
      .filter((r) => r.outcome === 'escaped')
      .map((r) => `${r.resolver} × ${r.mutation} in ${r.case} (${r.path}, conflict ${r.block + 1}): ${r.note}`);
    assert.deepEqual(escaped, [], summarize(report).lines.join('\n'));
    // The audit reaches every resolver and every mutation, so a lab change that loses one shows here.
    for (const resolver of RESOLVERS)
      assert.ok(
        report.results.some((r) => r.resolver === resolver),
        `No mutation of a ${resolver} result was audited.`
      );
    for (const mutation of MUTATIONS)
      assert.ok(
        report.results.some((r) => r.mutation === mutation && r.outcome === 'caught'),
        `No ${mutation} mutation was caught.`
      );
  }
);
