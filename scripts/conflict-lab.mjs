// Conflict lab: runs Gnosis's conflict preparation (#444: rerere, Mergiraf, tree-sitter checks) on every fixture in
// tests/fixtures/conflicts, or on the generated matrix, and scores the buckets it produces.
//
//   npm run conflict-lab                      every fixture case
//   npm run conflict-lab -- --only real-      cases whose name contains "real-"
//   npm run conflict-lab -- --matrix          the generated permutation matrix; writes /tmp/conflict-lab-report.md
//   npm run conflict-lab -- --json out.json   also write the raw results
//
// Offline: each case gets a private bare repository that stands in for GitHub. Nothing is pushed anywhere else.
// Runs under tsx (`npm run conflict-lab`), because it imports the TypeScript pipeline directly.
/* global AbortController, structuredClone */
import process from 'node:process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as TreeSitter from 'web-tree-sitter';
import { createConflictResolutionService } from '../src/conflict-resolution-service.ts';
import { blockBuckets, blockVerdict } from '../lib/conflict-verify.ts';
import { verdictKey } from '../lib/conflict-verdict-key.ts';
import { conflictChecker } from '../src/conflict-checks.ts';
import { blockProposals } from '../lib/conflict-carry.ts';
import { hasConflictMarkers } from '../lib/conflict-resolution.ts';
import { parseConflicts } from '../lib/conflict-blocks.ts';
import { createSyntaxEngine } from '../lib/syntax-scope.ts';
import { runConflictProcess } from '../src/conflict-process.ts';
import { proposedChecks } from './conflict-lab-fixes.mjs';
import { bare, bareGit, casePlan, commitFiles, loadCases, root, sortedLines, squash } from './conflict-lab-lib.mjs';

const require = createRequire(import.meta.url);
const MERGIRAF = path.join(
  root,
  'resources/mergiraf/runtime',
  process.platform === 'win32' ? 'mergiraf.exe' : 'mergiraf'
);
const assets = path.join(root, 'src/assets/tree-sitter');
const engine = createSyntaxEngine(TreeSitter, {
  runtime: async () => new Uint8Array(await fs.readFile(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))),
  grammar: async (language) => new Uint8Array(await fs.readFile(path.join(assets, `${language}.wasm`))),
  tags: (name) => fs.readFile(path.join(assets, `${name}-tags.scm`), 'utf8'),
});
/** A stand-in Mergiraf binary for the failure-path cases. */
async function mergirafFor(mode, dir, caseDir) {
  if (!mode || mode === 'real') return MERGIRAF;
  if (mode === 'missing') return path.join(dir, 'no-mergiraf');
  const script = path.join(dir, 'mergiraf-wrapper.sh');
  // A resolver output written by hand, from the case's canned/ directory, for a file that has one; Mergiraf for the
  // rest. The review probes use it to replay a wrong output exactly.
  if (mode === 'canned') {
    const canned = path.join(caseDir, 'canned');
    await fs.writeFile(
      script,
      `#!/bin/sh\nfor a in "$@"; do case "$a" in --path-name=*) name="\${a#--path-name=}";; esac; done\n` +
        `file='${canned}'/"$name"\nif [ -f "$file" ]; then cat "$file"; grep -q '^<<<<<<<' "$file" && exit 1; exit 0; fi\n` +
        `exec '${MERGIRAF}' "$@"\n`,
      { mode: 0o755 }
    );
    return script;
  }
  const body = {
    fail: 'echo "mergiraf: internal error" >&2\nexit 134\n',
    hang: 'sleep 60\n',
    // Mergiraf's own --timeout: it gives up on the structured merge and falls back to a line merge.
    timeout: `args=""; skip=0\nfor a in "$@"; do if [ $skip = 1 ]; then a=1; skip=0; fi; [ "$a" = "--timeout" ] && skip=1; args="$args '$a'"; done\neval exec '${MERGIRAF}' $args\n`,
    garbage: 'printf "this is not the file\\n"\nexit 0\n',
  }[mode];
  if (!body) throw new Error(`Unknown mergiraf mode ${mode}`);
  await fs.writeFile(script, `#!/bin/sh\n${body}`, { mode: 0o755 });
  return script;
}

/** Runs Mergiraf directly on one file, to say why a block got no proposal. */
async function diagnose(file, binary, dir) {
  const temp = await fs.mkdtemp(path.join(dir, 'diag-'));
  try {
    const names = ['base', 'ours', 'theirs'].map((n) => path.join(temp, n));
    await Promise.all(names.map((n, i) => fs.writeFile(n, [file.base, file.ours, file.theirs][i])));
    const result = await runConflictProcess(
      binary,
      [
        'merge',
        ...names,
        `--path-name=${file.path}`,
        '--timeout',
        '5000',
        '--base-name',
        'Common ancestor',
        '--left-name=feature',
        '--right-name=main',
      ],
      { cwd: temp, timeout: 10_000 }
    ).catch((error) => ({ code: -1, stdout: Buffer.from(''), stderr: String(error) }));
    if (result.code > 1 || result.code < 0)
      return { tier: 'mergiraf-failed', detail: result.stderr.trim().split('\n')[0] };
    const output = result.stdout.toString('utf8');
    const proposals = blockProposals(file.original, output, 'mergiraf');
    if (!hasConflictMarkers(output) && !proposals)
      return {
        tier: 'mapping-rejected',
        detail: 'Mergiraf merged the file, but changed lines Git had merged, so no block got a proposal.',
        output,
      };
    return { tier: 'mergiraf-conflict', detail: 'Mergiraf left these blocks conflicted.', proposals };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

/** How a Merged result compares with the known-correct resolution. Only `differs` counts as wrong. */
function compare(result, accepted, mergedBlocks) {
  if (accepted.some((r) => squash(r) === squash(result))) return 'exact';
  if (accepted.some((r) => mergedBlocks.every((b) => squash(r).includes(squash(b))))) return 'blocks-match';
  if (accepted.some((r) => sortedLines(r) === sortedLines(result))) return 'reordered';
  // Same code, but the merge broke the layout (a stray `;` line, an argument pulled onto the previous line).
  if (accepted.some((r) => bare(r) === bare(result))) return 'cosmetic';
  return 'differs';
}

/** `auto`: Merged, or merged by Git with no conflict; the generated matrix uses it. */
const EXPECT = new Set(['merged', 'check', 'decide', 'any-but-merged', 'any', 'clean', 'auto']);
function expectedFor(spec, count) {
  if (spec === undefined) return new Array(Math.max(count, 1)).fill('any');
  const list = Array.isArray(spec) ? spec : new Array(Math.max(count, 1)).fill(spec);
  for (const e of list) if (!EXPECT.has(e)) throw new Error(`Unknown expectation ${e}`);
  return list;
}

/** The steps a case runs: one PR, each PR of a stack, before and after a base move, or first and second PR. */
export function caseSteps(c) {
  if (c.meta.stack) return casePlan(c).map((pr) => pr.step);
  if (c.trees.theirs2) return ['before-move', 'after-move'];
  if (c.meta.rerere) return ['first', 'second'];
  return ['pr'];
}
/** What a step expects, per conflicted file. */
export const stepExpectations = (c, step) =>
  step === 'pr' ? c.meta.expected : (c.meta.steps?.[step] ?? c.meta.expected);
/** The known-correct resolution of a step, by path. */
const stepResolution = (c, step) =>
  c.meta.stack ? c.trees.resolvedSteps?.[step] : step === 'after-move' ? c.trees.resolved2 : c.trees.resolved;

/**
 * A case's private bare repository with the real conflict service on top of it. `step(name)` brings the repository
 * to that step, resolving and publishing the steps before it as a person would, and returns the PR URL to open. A
 * step that ends in a preview (the base move) also returns that reply. The conflict gallery serves this service to
 * the conflict workspace (scripts/conflict-gallery-server.mjs).
 */
export async function labRepo(c) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-conflict-lab-'));
  let ready = false;
  try {
    const lab = await openLab(c, dir);
    ready = true;
    return lab;
  } finally {
    // A setup that throws leaves no temporary directory behind.
    if (!ready) await fs.rm(dir, { recursive: true, force: true });
  }
}
async function openLab(c, dir) {
  const remote = path.join(dir, 'remote');
  const git = bareGit(remote);
  const index = path.join(dir, 'index');
  await fs.mkdir(remote);
  await git(['init', '--bare', '-q', '-b', 'main', '.']);
  await git(['config', 'uploadpack.allowFilter', 'true']);
  await git(['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  const { trees, meta } = c;
  const base = await commitFiles(git, { files: trees.base, message: 'base', index });
  const main = await commitFiles(git, {
    parent: base,
    files: trees.theirs,
    replace: true,
    message: 'main change',
    index,
  });
  await git(['update-ref', 'refs/heads/main', main]);
  const plan = casePlan(c);
  let parent = base;
  for (const pr of plan) {
    parent = await commitFiles(git, { parent, files: pr.tree, replace: true, message: `${pr.step} change`, index });
    await git(['update-ref', `refs/heads/${pr.head}`, parent]);
  }
  const repo = `lab/${c.name.replace(/[^\w.-]/g, '-').slice(0, 80)}`;
  const prs = new Map(); // url -> { head, base }
  const urlFor = (n) => `https://github.com/${repo}/pull/${n}`;
  plan.forEach((pr, i) => prs.set(urlFor(i + 1), pr));
  const sha = async (ref) => (await git(['rev-parse', `refs/heads/${ref}`])).stdout;
  const data = new Map();
  const context = { account: 'lab', token: 'offline' };
  const binary = await mergirafFor(meta.mergiraf, dir, c.dir);
  const service = createConflictResolutionService({
    storage: {
      read: (key) => structuredClone(data.get(key)),
      write: (key, value) => void data.set(key, structuredClone(value)),
      flush: async () => {},
    },
    directory: () => path.join(dir, 'cache'),
    context: () => context,
    read: async (url) => {
      const pr = prs.get(url);
      if (!pr) throw new Error(`No lab PR at ${url}`);
      return {
        account: 'lab',
        url,
        repository: repo,
        headRepo: repo,
        title: c.name,
        headSha: await sha(pr.head),
        baseSha: await sha(pr.base),
        headBranch: pr.head,
        baseBranch: pr.base,
        state: 'OPEN',
        archived: false,
        canUpdateBranch: true,
      };
    },
    remote: () => remote,
    mergeBase: async (_repo, b, h) => (await git(['merge-base', b, h])).stdout,
    mergiraf: () => binary,
    suggest: () => Promise.reject(new Error('No AI in the conflict lab.')),
    // The service checks proposals as the app's main process does (src/conflict-checks.ts), with the case's settings.
    verify: (file, disabled) => conflictChecker(engine, disabled)(file),
    disabledLanguages: () => meta.languagesOff ?? [],
  });
  const run = (request, signal = new AbortController().signal) => service.run(request, signal);

  async function resolveAndPublish(session, resolvedTree) {
    let s = session;
    for (const f of s.files) {
      if (f.unsupported) throw new Error(`${f.path} needs a local merge tool, so the lab cannot publish this step.`);
      const contents =
        resolvedTree?.get(f.path)?.toString('utf8') ?? (hasConflictMarkers(f.result) ? undefined : f.result);
      if (contents === undefined) throw new Error(`No resolution for ${f.path}.`);
      s = (await run({ kind: 'save', id: s.id, version: s.version, path: f.path, contents, resolved: true })).session;
    }
    return s;
  }
  async function publish(session) {
    const reply = await run({ kind: 'preview', id: session.id, version: session.version });
    if (!reply.preview) return reply;
    return run({
      kind: 'publish',
      id: session.id,
      version: session.version,
      previewToken: reply.preview.token,
      message: 'Resolve conflicts',
    });
  }
  async function step(name) {
    if (meta.stack) {
      const i = plan.findIndex((pr) => pr.step === name);
      for (let k = 0; k < i; k++) {
        const { session } = await run({ kind: 'open', url: urlFor(k + 1) });
        if (session.files.length) await publish(await resolveAndPublish(session, trees.resolvedSteps?.[plan[k].step]));
      }
      return { url: urlFor(i + 1) };
    }
    if (name === 'after-move') {
      const { session } = await run({ kind: 'open', url: urlFor(1) });
      const reviewed = await resolveAndPublish(session, trees.resolved);
      const moved = await commitFiles(git, {
        parent: main,
        files: trees.theirs2,
        replace: true,
        message: 'main moves again',
        index,
      });
      await git(['update-ref', 'refs/heads/main', moved]);
      const reply = await run({ kind: 'preview', id: reviewed.id, version: reviewed.version });
      return { url: urlFor(1), reply };
    }
    if (name === 'second') {
      const { session } = await run({ kind: 'open', url: urlFor(1) });
      await publish(await resolveAndPublish(session, trees.resolved));
      const again = await commitFiles(git, {
        parent: base,
        files: trees.ours,
        replace: true,
        message: 'the same change again',
        index,
      });
      await git(['update-ref', 'refs/heads/again', again]);
      prs.set(urlFor(2), { head: 'again', base: 'main' });
      return { url: urlFor(2) };
    }
    return { url: urlFor(1) };
  }
  return { dir, git, run, step, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/**
 * One case through the service, step by step (one PR, a stack of PRs, a base move, or a remembered resolution). Each
 * step after the first gets its own repository, where the steps before it are resolved and published again.
 */
export async function runCase(c, { keep = false } = {}) {
  const steps = [];
  const labs = [];
  const { meta } = c;
  try {
    let active;
    async function score(stepName, session, resolvedTree, expectedSpec) {
      const { dir } = active;
      const files = [];
      const expectedFiles = new Map(Object.entries(expectedSpec ?? {}));
      for (const f of session.files) {
        // The verdict the service saved with the draft, for these proposals: as the conflict dialog reads it. A check
        // that failed saves nothing, and fails the case.
        if ((f.proposals || f.wholeFile) && f.verdict?.key !== verdictKey(f, meta.languagesOff ?? []))
          throw new Error(`${f.path} has proposals the service did not check.`);
        const verdict = f.verdict?.verdict;
        const buckets = blockBuckets(f, f.result, verdict);
        // The checks proposed for #444, measured on the side: what the buckets would be with them.
        const fixNote = buckets.includes('merged') ? proposedChecks(f) : undefined;
        const bucketsWithFixes = fixNote ? blockBuckets(f, f.result, { merged: false, note: fixNote }) : buckets;
        const expected = expectedFor(expectedFiles.get(f.path), buckets.length);
        expectedFiles.delete(f.path);
        const entry = {
          path: f.path,
          buckets,
          bucketsWithFixes,
          fixNote,
          expected,
          note: verdict?.note ?? f.structuralNote,
          // Each conflict's own reason (#445 item 18), and which proposals are unions of both sides' additions.
          notes: buckets.map(
            (_, i) => (f.proposals?.[i] ? blockVerdict(verdict, i)?.note : undefined) ?? f.structuralNote
          ),
          sources: buckets.map((_, i) => f.proposals?.[i]?.source),
          unsupported: f.unsupported,
          source: f.source,
        };
        // Why blocks got no proposal.
        if (!f.unsupported && buckets.some((b) => b === 'decide')) {
          if (meta.mergiraf && meta.mergiraf !== 'real') entry.tier = `mergiraf-${meta.mergiraf}`;
          else {
            const d = await diagnose(f, MERGIRAF, dir);
            entry.tier = d.tier;
            entry.detail = d.detail;
            if (d.output !== undefined) entry.wholeFile = d.output;
          }
        } else if (f.unsupported) entry.tier = 'unsupported';
        if (buckets.some((b) => b === 'check')) entry.tier = entry.tier ? `${entry.tier}+verify` : 'verify';
        // Merged results against the known-correct resolution.
        const accepted = [
          ...(resolvedTree?.has(f.path) ? [resolvedTree.get(f.path).toString('utf8')] : []),
          ...(meta.acceptable?.[f.path] ?? []),
        ];
        // A whole-file proposal is in Check. It is correct when it equals a known-correct resolution, whitespace aside.
        if (f.wholeFile) {
          entry.tier = 'whole-file';
          if (accepted.length)
            entry.wholeFileProposal = accepted.some((r) => squash(r) === squash(f.wholeFile.text))
              ? 'correct'
              : 'differs';
        }
        const segments = parseConflicts(f.original).filter((s) => s.kind === 'conflict');
        const mergedBlocks = segments.filter((_, i) => buckets[i] === 'merged').map((s) => f.proposals[s.index].text);
        if (mergedBlocks.length) {
          entry.mergedText = f.result;
          if (accepted.length) entry.comparison = compare(f.result, accepted, mergedBlocks);
        }
        // Could a Decide block have had a proposal? Mergiraf's whole-file result, where the block mapping rejected
        // it, and a union of both sides where each side only added lines (the base part is empty).
        if (accepted.length && buckets.includes('decide') && !f.unsupported) {
          if (entry.wholeFile !== undefined) entry.wholeFileComparison = compare(entry.wholeFile, accepted, []);
          const union = parseConflicts(f.result)
            .map((x) =>
              x.kind === 'text' ? x.text : x.block.base === '' ? x.block.ours + x.block.theirs : x.block.raw
            )
            .join('');
          if (!hasConflictMarkers(union)) entry.unionComparison = compare(union, accepted, []);
        }
        delete entry.wholeFile;
        files.push(entry);
      }
      // Expected conflicts that Git merged on its own.
      for (const [p, spec] of expectedFiles) {
        const entry = { path: p, buckets: [], bucketsWithFixes: [], expected: expectedFor(spec, 1), clean: true };
        const accepted = [
          ...(resolvedTree?.has(p) ? [resolvedTree.get(p).toString('utf8')] : []),
          ...(meta.acceptable?.[p] ?? []),
        ];
        // What Git merged on its own, against the known-correct resolution.
        if (accepted.length && session.headSha && session.baseSha) {
          const merge = await active.git(['merge-tree', '--write-tree', session.headSha, session.baseSha], {
            allowed: [0, 1],
          });
          const text = await active.git(['cat-file', 'blob', `${merge.stdout.split('\n')[0]}:${p}`], {
            allowed: [0, 128],
            encoding: 'buffer',
          });
          entry.mergedText = text.code ? '' : text.stdout.toString('utf8');
          entry.comparison = text.code ? 'differs' : compare(entry.mergedText, accepted, []);
        }
        files.push(entry);
      }
      steps.push({ step: stepName, preparation: session.preparation, files });
    }

    for (const name of caseSteps(c)) {
      active = await labRepo(c);
      labs.push(active);
      const { url, reply } = await active.step(name);
      const session = reply?.session ?? (await active.run({ kind: 'open', url })).session;
      await score(name, session, stepResolution(c, name), stepExpectations(c, name));
      if (reply) steps.at(-1).baseMoved = reply.baseMoved;
    }
    return {
      name: c.name,
      meta: {
        description: meta.description,
        language: meta.language,
        category: meta.category,
        pattern: meta.pattern,
        axes: meta.axes,
      },
      steps,
    };
  } catch (error) {
    return {
      name: c.name,
      meta: {
        description: meta.description,
        language: meta.language,
        category: meta.category,
        pattern: meta.pattern,
        axes: meta.axes,
      },
      steps,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (!keep) await Promise.all(labs.map((lab) => lab.cleanup()));
  }
}

export async function runAll(cases, { concurrency = Math.max(2, Math.min(8, os.cpus().length - 2)), progress } = {}) {
  const results = new Array(cases.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let i = next++; i < cases.length; i = next++) {
        results[i] = await runCase(cases[i]);
        progress?.(++done, cases.length, cases[i].name);
      }
    })
  );
  return results;
}

/** Why a Merged block is wrong, or ''. */
function wrongness(expected, actual, comparison) {
  if (actual !== 'merged') return '';
  if (expected === 'any-but-merged') return 'Merged where Merged is unsafe';
  if (expected === 'decide') return 'Merged where no safe proposal exists';
  if (comparison === 'differs') return 'Merged result differs from the known-correct resolution';
  return '';
}
/**
 * Each conflict block as one row: what was expected, what happened, and whether a Merged was wrong. `withFixes` is the
 * same block with the checks proposed for #444 (scripts/conflict-lab-fixes.mjs).
 */
export function blocks(results) {
  const rows = [];
  for (const r of results)
    for (const s of r.steps)
      for (const f of s.files) {
        const n = Math.max(f.expected.length, f.buckets.length, 1);
        for (let i = 0; i < n; i++) {
          const expected = f.expected[i] ?? f.expected.at(-1) ?? 'any';
          const actual = f.clean ? 'clean' : (f.buckets[i] ?? 'none');
          const withFixes = f.clean ? 'clean' : ((f.bucketsWithFixes ?? f.buckets)[i] ?? 'none');
          rows.push({
            case: r.name,
            step: s.step,
            path: f.path,
            index: i,
            expected,
            actual,
            withFixes,
            wrong: wrongness(expected, actual, f.comparison),
            wrongWithFixes: wrongness(expected, withFixes, f.comparison),
            tier: f.tier,
            detail: f.detail,
            note: f.notes?.[i] ?? f.note,
            source: f.sources?.[i],
            fixNote: f.fixNote,
            comparison: f.comparison,
            wholeFile: f.wholeFileProposal,
            meta: r.meta,
          });
        }
      }
  return rows;
}

const ACTUAL = ['merged', 'check', 'decide', 'decided', 'clean', 'none'];
export function confusion(rows) {
  const matrix = {};
  for (const row of rows) {
    matrix[row.expected] ??= Object.fromEntries(ACTUAL.map((a) => [a, 0]));
    matrix[row.expected][row.actual] = (matrix[row.expected][row.actual] ?? 0) + 1;
  }
  return matrix;
}
export function matches(expected, actual) {
  if (expected === 'any') return true;
  if (expected === 'auto') return actual === 'merged' || actual === 'clean';
  if (expected === 'any-but-merged') return actual !== 'merged';
  return expected === actual;
}

function table(header, body) {
  const lines = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`];
  for (const row of body) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}
export function fixtureReport(results) {
  const rows = blocks(results);
  const out = ['# Conflict lab: fixture corpus', ''];
  out.push(
    table(
      ['case', 'step', 'file', 'expected', 'actual', 'ok', 'with fixes', 'why / comparison'],
      rows.map((r) => [
        r.case,
        r.step,
        r.path,
        r.expected,
        r.actual,
        r.wrong ? 'WRONG MERGED' : matches(r.expected, r.actual) ? 'yes' : 'no',
        r.withFixes === r.actual ? '' : `${r.withFixes} (${r.fixNote})`,
        [r.tier, r.note, r.comparison, r.wholeFile && `whole file ${r.wholeFile}`].filter(Boolean).join('; '),
      ])
    )
  );
  const errors = results.filter((r) => r.error);
  if (errors.length) out.push('', '## Cases that failed to run', '', ...errors.map((r) => `- ${r.name}: ${r.error}`));
  const m = confusion(rows);
  out.push('', '## Expected (rows) against actual (columns), per conflict block', '');
  out.push(
    table(
      ['expected', ...ACTUAL],
      Object.entries(m).map(([e, v]) => [e, ...ACTUAL.map((a) => String(v[a] ?? 0))])
    )
  );
  const wrong = rows.filter((r) => r.wrong);
  out.push(
    '',
    `## Wrong Merged: ${wrong.length}`,
    '',
    ...wrong.map(
      (r) =>
        `- ${r.case} (${r.path}, block ${r.index + 1}): ${r.wrong}. ${r.meta.description ?? ''}${r.fixNote ? ` With the proposed checks: ${r.withFixes} (${r.fixNote})` : ' The proposed checks do not catch it.'}`
    )
  );
  const wrongWithFixes = rows.filter((r) => r.wrongWithFixes);
  const lost = rows.filter((r) => r.actual === 'merged' && r.withFixes !== 'merged' && !r.wrong);
  out.push(
    '',
    `## With the proposed checks: ${wrongWithFixes.length} wrong Merged; ${lost.length} correct Merged moved to Check`,
    '',
    ...lost.map((r) => `- ${r.case} (${r.path}, block ${r.index + 1}): ${r.fixNote}`)
  );
  const whole = rows.filter((r) => r.tier === 'whole-file');
  out.push(
    '',
    `## Conflicts with a whole-file proposal: ${whole.length}, ${whole.filter((r) => r.wholeFile === 'correct').length} equal the known-correct resolution`,
    '',
    ...whole.map((r) => `- ${r.case} (${r.path}): ${r.wholeFile ?? 'no known-correct resolution'}. ${r.note ?? ''}`)
  );
  const mismatched = rows.filter((r) => !r.wrong && !matches(r.expected, r.actual));
  out.push(
    '',
    `## Other mismatches: ${mismatched.length}`,
    '',
    ...mismatched.map(
      (r) =>
        `- ${r.case} (${r.path}, block ${r.index + 1}): expected ${r.expected}, got ${r.actual}. ${[r.tier, r.detail, r.note].filter(Boolean).join('; ')}`
    )
  );
  return { text: out.join('\n'), rows, wrong, wrongWithFixes, lost };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const only = value('--only');
  const progress = (done, total, name) => process.stderr.write(`\r${done}/${total} ${name}`.padEnd(100).slice(0, 100));
  const started = Date.now();
  if (flag('--matrix')) {
    const { generateMatrix, matrixReport } = await import('./conflict-lab-generate.mjs');
    const cases = generateMatrix({
      seed: Number(value('--seed') ?? 1),
      variants: Number(value('--variants') ?? 4),
      filter: only,
    });
    const results = await runAll(cases, { progress });
    process.stderr.write('\n');
    const report = matrixReport(results, cases);
    const out = value('--out') ?? '/tmp/conflict-lab-report.md';
    await fs.writeFile(out, report.text);
    if (value('--json')) await fs.writeFile(value('--json'), JSON.stringify(results, null, 2));
    console.log(report.headline);
    console.log(
      `Wrong Merged: ${report.wrong.length}. Report: ${out} (${((Date.now() - started) / 1000).toFixed(0)} s)`
    );
    process.exitCode = report.wrong.length ? 1 : 0;
    return;
  }
  const cases = await loadCases(only ? (n) => n.includes(only) : undefined);
  const results = await runAll(cases, { progress });
  process.stderr.write('\n');
  const report = fixtureReport(results);
  console.log(report.text);
  if (value('--out')) await fs.writeFile(value('--out'), report.text);
  if (value('--json')) await fs.writeFile(value('--json'), JSON.stringify(results, null, 2));
  console.log(
    `\n${cases.length} cases, ${report.rows.length} conflict blocks, ${report.wrong.length} wrong Merged (${((Date.now() - started) / 1000).toFixed(0)} s).`
  );
  process.exitCode = report.wrong.length || results.some((r) => r.error) ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
