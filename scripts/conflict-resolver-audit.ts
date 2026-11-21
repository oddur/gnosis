/**
 * The resolver audit (#445 item 19): every resolver's checked result, mutated, must never end Merged. See
 * scripts/conflict-resolver-audit-core.ts and docs/conflict-resolution.md.
 *
 *   npm run conflict-resolver-audit                     the fixtures and one matrix case per pattern and language
 *   npm run conflict-resolver-audit -- --all            the fixtures and the whole matrix
 *   npm run conflict-resolver-audit -- --only ts-       cases whose name contains "ts-"
 *
 * Options: `--variants N` matrix cases per pattern and language, `--show N` escapes to print in full (default 5).
 * Exits 1 when a mutation escaped or a case failed to run.
 */
import process from 'node:process';
import fs from 'node:fs';
import { MERGIRAF, runResolverAudit, summarize } from './conflict-resolver-audit-core';

const args = process.argv.slice(2);
const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (!fs.existsSync(MERGIRAF)) {
  console.error('Mergiraf is missing. Run npm run prepare:mergiraf first.');
  process.exit(1);
}
async function main() {
  const report = await runResolverAudit({
    all: args.includes('--all'),
    variants: value('--variants') ? Number(value('--variants')) : undefined,
    only: value('--only'),
    progress: (done, total, name) =>
      process.stderr.isTTY && process.stderr.write(`\r${done}/${total} ${name}`.padEnd(100).slice(0, 100)),
  });
  if (process.stderr.isTTY) process.stderr.write('\n');
  const { lines, baseline } = summarize(report);
  console.log(lines.join('\n'));
  console.log(`\n${baseline}`);
  const escaped = report.results.filter((r) => r.outcome === 'escaped');
  const show = Number(value('--show') ?? 5);
  for (const [i, r] of escaped.entries()) {
    console.log(
      `\nESCAPED: ${r.resolver} × ${r.mutation} in ${r.case} (${r.path}, conflict ${r.block + 1}). ${r.note}`
    );
    if (i < show && r.text) console.log(r.text.replace(/^/gm, '    '));
  }
  for (const error of report.errors) console.log(`\nFAILED TO RUN: ${error}`);
  console.log(
    `\n${report.cases} cases, ${report.files} conflicted files, ${report.results.length} mutations, ${escaped.length} escaped (${(report.ms / 1000).toFixed(1)} s).`
  );
  process.exitCode = escaped.length || report.errors.length ? 1 : 0;
}
void main();
