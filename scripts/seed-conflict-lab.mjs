// Seeds a scratch GitHub repository with the conflict lab's cases as real conflicting PRs, so they can be resolved end
// to end in a Gnosis build. Idempotent: commits have fixed authors and dates, so a rerun builds the same SHAs; branches
// are reset to them, stale case branches are deleted, and their PRs closed.
//
//   node scripts/seed-conflict-lab.mjs --repo oddur/gnosis-conflict-lab --dry-run
//   node scripts/seed-conflict-lab.mjs --repo oddur/gnosis-conflict-lab            pushes and opens PRs (uses gh)
//   node scripts/seed-conflict-lab.mjs --repo o/r --remote /tmp/lab.git            pushes to a local bare repo; no PRs
//   ... --only ts-             cases whose name contains "ts-"
//   ... --sample 12            also 12 generated matrix cases, spread across the patterns
//   ... --patterns add-import,rename-vs-new-use   also every language of these matrix patterns (one variant each)
//   ... --move-base base-moves-during-resolution  pushes that case's second main commit, while its workspace is open
//
// Layout: the remote's first commit (its README) is the root. One commit adds every case's base files under
// cases/<name>/; main then gets one commit per case with main's side. Each case branch starts from the base commit:
// case/<name> for one PR, case/<name>-pr1..3 for a stack (each PR targets the previous branch), and
// case/<name>-again for a remembered-resolution case. Run with Node 20 or newer, from the repository root.
import process from 'node:process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { bareGit, casePlan, commitFiles, loadCases } from './conflict-lab-lib.mjs';
import { generateMatrix } from './conflict-lab-generate.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const repo = value('--repo');
const dryRun = flag('--dry-run');
const localRemote = value('--remote');
const moveBase = value('--move-base');
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error(
    'Usage: node scripts/seed-conflict-lab.mjs --repo owner/name [--dry-run] [--remote path] [--only text] [--sample N] [--patterns a,b] [--move-base case]'
  );
  process.exit(2);
}
const remote = localRemote ?? `https://github.com/${repo}.git`;
const log = (...line) => console.log(...line);

/** Cases the seeder cannot reproduce on GitHub, and why. */
function unsupported(c) {
  if (c.meta.mergiraf && c.meta.mergiraf !== 'real')
    return 'it replaces the Mergiraf binary, which only the offline lab can do';
}
function notes(c) {
  const out = [];
  if (c.meta.languagesOff?.length)
    out.push(
      `Before opening it, turn ${c.meta.languagesOff.join(', ')} off in Settings > Appearance > Code intelligence.`
    );
  if (c.trees.theirs2)
    out.push(
      `While its conflict workspace is open, run \`node scripts/seed-conflict-lab.mjs --repo ${repo} --move-base ${c.name}\` to move main, then preview.`
    );
  if (c.meta.rerere)
    out.push('Resolve and publish the first PR, then open the `-again` PR: Gnosis should reuse the resolution.');
  if (c.meta.stack) out.push('A stack: resolve the PRs bottom up, one at a time.');
  return out;
}
function expectations(c) {
  const lines = [];
  const show = (label, spec) => {
    for (const [p, e] of Object.entries(spec ?? {}))
      lines.push(`- ${label}\`${p}\`: ${Array.isArray(e) ? e.join(', ') : e}`);
  };
  if (c.meta.steps) for (const [step, spec] of Object.entries(c.meta.steps)) show(`${step}: `, spec);
  else show('', c.meta.expected);
  return lines;
}

async function loadSelection() {
  const only = value('--only');
  const cases = await loadCases(only ? (n) => n.includes(only) : undefined);
  const sample = Number(value('--sample') ?? 0);
  const patterns = value('--patterns')?.split(',').filter(Boolean);
  if (sample || patterns) {
    let generated = generateMatrix({ variants: 1, patterns });
    if (sample && !patterns) {
      // Spread across patterns and languages: round-robin by pattern, each pattern starting at a different language.
      const byPattern = new Map();
      for (const c of generated)
        (byPattern.get(c.meta.pattern) ?? byPattern.set(c.meta.pattern, []).get(c.meta.pattern)).push(c);
      const lists = [...byPattern.values()];
      generated = [];
      for (let k = 0; generated.length < sample && lists.some((l) => l.length > k); k++)
        lists.forEach((l, i) => {
          if (k < l.length && generated.length < sample) generated.push(l[(k + i) % l.length]);
        });
    }
    // A generated case can also be one of the committed samples: seed it once.
    cases.push(...generated.filter((g) => !cases.some((c) => c.name === g.name)));
  }
  return cases;
}

function run(command, argv, { cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, argv, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(`${command} ${argv.join(' ')}: ${stderr || error.message}`)) : resolve(stdout.trim())
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

async function main() {
  const cases = (await loadSelection()).filter((c) => {
    const why = unsupported(c);
    if (why) log(`skip ${c.name}: ${why}`);
    return !why;
  });
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-conflict-seed-'));
  const git = bareGit(work);
  const index = path.join(work, 'index');
  try {
    await git(['init', '--bare', '-q', '-b', 'main', '.']);
    // The root: the remote's first commit. A dry run never contacts the remote, so it starts from a stand-in README.
    let root;
    if (dryRun) {
      root = await commitFiles(git, {
        files: new Map([['README.md', Buffer.from('# gnosis-conflict-lab\n')]]),
        message: 'Initial commit',
        index,
      });
      log(`dry run: not contacting ${localRemote ?? repo}; using a stand-in root commit ${root.slice(0, 12)}`);
    } else {
      await git(['fetch', '-q', '--no-tags', remote, '+refs/heads/main:refs/remotes/origin/main']);
      root = (await git(['rev-list', '--max-parents=0', 'refs/remotes/origin/main'])).stdout.split('\n').at(-1);
    }
    const prefix = (c) => `cases/${c.name}`;
    let base = root;
    // Base files of every case, in one commit.
    const all = new Map();
    for (const c of cases) for (const [p, data] of c.trees.base) all.set(`${prefix(c)}/${p}`, data);
    base = await commitFiles(git, {
      parent: root,
      files: all,
      message: `Conflict lab: base files for ${cases.length} cases`,
      index,
    });
    let main = base;
    const mainOf = new Map();
    for (const c of cases) {
      main = await commitFiles(git, {
        parent: main,
        files: c.trees.theirs,
        prefix: prefix(c),
        replace: true,
        message: `${c.name}: main's change\n\n${c.meta.description ?? ''}`,
        index,
      });
      mainOf.set(c.name, main);
    }
    const refs = new Map([['main', main]]);
    const prs = []; // { head, base, title, body }
    for (const c of cases) {
      const plan = casePlan(c);
      let parent = base;
      const branch = (pr) => (plan.length > 1 ? `case/${c.name}-${pr.step}` : `case/${c.name}`);
      for (const pr of plan) {
        parent = await commitFiles(git, {
          parent,
          files: pr.tree,
          prefix: prefix(c),
          replace: true,
          message: `${c.name}: ${plan.length > 1 ? `${pr.step} ` : ''}PR change\n\n${c.meta.description ?? ''}`,
          index,
        });
        refs.set(branch(pr), parent);
      }
      const body = [
        c.meta.description ?? '',
        '',
        `Category: ${c.meta.category}. Language: ${c.meta.language}.`,
        ...(c.meta.source ? [`Source: ${c.meta.source.url ?? c.meta.source.repo} (${c.meta.source.license}).`] : []),
        '',
        'Expected buckets per conflict:',
        ...expectations(c),
        ...(notes(c).length ? ['', ...notes(c)] : []),
        '',
        `Generated by scripts/seed-conflict-lab.mjs from tests/fixtures/conflicts/${c.name.startsWith('gen-') ? 'MATRIX.md' : c.name}.`,
      ].join('\n');
      plan.forEach((pr, i) => {
        prs.push({
          case: c.name,
          head: branch(pr),
          base: i ? branch(plan[i - 1]) : 'main',
          title: `[lab] ${c.name}${plan.length > 1 ? ` (${pr.step})` : ''}`,
          body,
        });
      });
      if (c.meta.rerere) {
        const again = await commitFiles(git, {
          parent: base,
          files: c.trees.ours,
          prefix: prefix(c),
          replace: true,
          message: `${c.name}: the same PR change again`,
          index,
        });
        refs.set(`case/${c.name}-again`, again);
        prs.push({ case: c.name, head: `case/${c.name}-again`, base: 'main', title: `[lab] ${c.name} (again)`, body });
      }
    }

    if (moveBase) {
      const c = cases.find((x) => x.name === moveBase);
      if (!c?.trees.theirs2) throw new Error(`${moveBase} is not a base-move case.`);
      const moved = await commitFiles(git, {
        parent: main,
        files: c.trees.theirs2,
        prefix: prefix(c),
        replace: true,
        message: `${c.name}: main moves again`,
        index,
      });
      log(`move main ${main.slice(0, 12)} -> ${moved.slice(0, 12)} (${c.name})`);
      if (dryRun) log(`dry run: would run git push ${remote} ${moved}:refs/heads/main`);
      else await git(['push', remote, `${moved}:refs/heads/main`]);
      return;
    }

    // Branches: reset the planned ones, delete stale case/* branches.
    const existing = dryRun
      ? new Map()
      : new Map(
          (await git(['ls-remote', '--heads', remote])).stdout
            .split('\n')
            .filter(Boolean)
            .map((l) => l.split('\t'))
            .map(([sha, ref]) => [ref.replace('refs/heads/', ''), sha])
        );
    const stale = [...existing.keys()].filter((b) => b.startsWith('case/') && !refs.has(b));
    const changed = [...refs].filter(([b, sha]) => existing.get(b) !== sha);
    log(
      `${cases.length} cases, ${refs.size} branches (${changed.length} to update, ${stale.length} stale), ${prs.length} PRs`
    );
    for (const [b, sha] of refs) log(`  ${existing.get(b) === sha ? 'same  ' : 'update'} ${b} ${sha.slice(0, 12)}`);
    for (const b of stale) log(`  delete ${b}`);
    const specs = [...changed.map(([b, sha]) => `+${sha}:refs/heads/${b}`), ...stale.map((b) => `:refs/heads/${b}`)];
    if (dryRun) log(`dry run: would run git push --atomic ${remote} <${specs.length} refspecs>`);
    else if (specs.length) {
      // Several hundred refspecs fit in one atomic push.
      await git(['push', '--atomic', '-q', remote, ...specs]);
      log(`pushed ${specs.length} refs to ${localRemote ?? repo}`);
    }

    // Pull requests, through gh. A local remote has none.
    if (localRemote) {
      log('local remote: no pull requests. Planned PRs:');
      for (const pr of prs) log(`  ${pr.head} -> ${pr.base}  ${pr.title}`);
      return;
    }
    const open = dryRun
      ? []
      : JSON.parse(
          await run('gh', [
            'pr',
            'list',
            '--repo',
            repo,
            '--state',
            'open',
            '--limit',
            '1000',
            '--json',
            'number,headRefName,baseRefName',
          ])
        );
    const byHead = new Map(open.map((p) => [p.headRefName, p]));
    for (const pr of prs) {
      const current = byHead.get(pr.head);
      if (current && current.baseRefName === pr.base) log(`  keep   #${current.number} ${pr.head}`);
      else if (current) {
        log(`  retarget #${current.number} ${pr.head} -> ${pr.base}`);
        if (!dryRun) await run('gh', ['pr', 'edit', String(current.number), '--repo', repo, '--base', pr.base]);
      } else {
        log(`  open   ${pr.head} -> ${pr.base}  ${pr.title}`);
        if (!dryRun)
          await run('gh', [
            'pr',
            'create',
            '--repo',
            repo,
            '--head',
            pr.head,
            '--base',
            pr.base,
            '--title',
            pr.title,
            '--body',
            pr.body,
          ]);
      }
    }
    for (const p of open)
      if (p.headRefName.startsWith('case/') && !prs.some((pr) => pr.head === p.headRefName)) {
        log(`  close  #${p.number} ${p.headRefName} (stale)`);
        if (!dryRun)
          await run('gh', [
            'pr',
            'close',
            String(p.number),
            '--repo',
            repo,
            '--comment',
            'This conflict-lab case no longer exists.',
          ]);
      }
    if (dryRun) log(`dry run: would open or keep ${prs.length} PRs in ${repo} with gh; nothing was pushed.`);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
await main();
