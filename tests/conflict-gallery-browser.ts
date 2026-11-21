// Conflict gallery: every conflict-lab fixture (tests/fixtures/conflicts) and a sample of the generated matrix, opened
// in the real conflict workspace. The workspace's requests go to scripts/conflict-gallery-server.mjs, which runs them
// through the real conflict service on a private bare repository per case, so preparation (rerere, Mergiraf) and the
// checks run as in the app. For each case the suite waits until preparation and checks settle, compares the buckets,
// summary, file-list badge and header badge with the case's expectations and with each other, and takes a screenshot.
// A few cases also go through the interactions, up to the push confirmation; nothing is ever pushed.
//
//   npm run test:browser:docker -- --conflict-gallery
//   GNOSIS_GALLERY_ONLY=add-import,real- npm run test:browser:docker -- --conflict-gallery
//
// Writes /tmp/conflict-gallery/<case>.png (light), <case>-dark.png for a subset, interactions/<case>-NN-<step>.png,
// results.json and index.html, the contact sheet. Local only: it takes several minutes (see LOCAL_SCRIPTS).
import { loadWorkbenchPage, waitForWorkbenchQueue, waitSettled } from './workbench-ready';
import { app, BrowserWindow } from 'electron';
app.disableHardwareAcceleration();
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.env.GNOSIS_GALLERY_DIR ?? '/tmp/conflict-gallery';
/** Cases that also go through the interactions: two Merged, three Decide, two Check, and two files. */
const INTERACT = (
  process.env.GNOSIS_GALLERY_INTERACT ??
  'cs-add-usings-and-methods,real-ts-typeorm-column-decorator,real-py-werkzeug-plain-int,real-cs-polly-cache-tryget'
).split(',');

/** merged, check, decide or decided; clean for a file Git merged on its own. */
type Bucket = string;
type Expectation = string | string[];
interface Entry {
  id: string;
  name: string;
  step: string;
  description: string;
  category: string;
  language: string;
  pattern?: string;
  expected: Record<string, Expectation>;
  languagesOff: string[];
}
interface Badge {
  bucket: string;
  text: string;
}
interface FileRow {
  path: string;
  current: boolean;
  badges: Badge[];
  stage: string | null;
  stageText: string | null;
  limitation: string | null;
}
interface Screen {
  title: string | null;
  summary: string | null;
  files: FileRow[];
  blocks: Bucket[];
  header: { stage: string | null; text: string | null };
  wholeFile: boolean;
  mergedLines: number;
  state: string | null;
  error: string | null;
  footer: string | null;
  primary: string | null;
  spill: string[];
  truncated: string[];
}
interface FileResult {
  path: string;
  expected: string[];
  actual: Bucket[];
  ok: boolean;
}
interface Result {
  entry: Entry;
  files: FileResult[];
  summary: string | null;
  problems: string[];
  notes: string[];
  shots: string[];
  seconds: number;
}

/** The focused block's index, or the footer action that has focus. */
const ACTIVE =
  "document.activeElement?.closest('.conflict-block')?.dataset.conflictIndex ?? document.activeElement?.dataset.conflictPrimary ?? null";
/** What the page shows now, read in one go. */
const READ = `(() => {
  const ws = document.querySelector('.conflict-workspace');
  if (!ws) return null;
  const text = (e) => (e ? e.textContent.replace(/\\s+/g, ' ').trim() : null);
  const box = ws.getBoundingClientRect();
  const visible = (e) => e.checkVisibility();
  const name = (e) => e.className && typeof e.className === 'string' ? e.tagName.toLowerCase() + '.' + e.className.split(' ')[0] : e.tagName.toLowerCase();
  const watched = [...ws.querySelectorAll('.conflict-heading *, .conflict-summary *, .conflict-footer *, .conflict-files *, .conflict-file-header *, .conflict-block-header *, .conflict-kept *')].filter(visible);
  return {
    title: text(ws.querySelector('h2')),
    summary: text(ws.querySelector('[data-conflict-summary]')),
    files: [...ws.querySelectorAll('nav.conflict-files > button')].map((b) => ({
      path: b.querySelector('span[title]')?.getAttribute('title') ?? text(b),
      current: b.getAttribute('aria-current') === 'true',
      badges: [...b.querySelectorAll('.conflict-bucket')].map((e) => ({ bucket: e.dataset.bucket, text: text(e) })),
      stage: b.querySelector('.conflict-file-status')?.dataset.stage ?? null,
      stageText: text(b.querySelector('.conflict-file-status')),
      limitation: text(b.querySelector('.conflict-file-limitation')),
    })),
    blocks: [...ws.querySelectorAll('.conflict-view .conflict-block')]
      .filter((b) => Number(b.dataset.conflictIndex) >= 0)
      .map((b) => b.dataset.bucket ?? (b.dataset.state === 'open' ? 'decide' : b.dataset.state === 'kept' ? 'decided' : b.dataset.state)),
    header: {
      stage: ws.querySelector('.conflict-file-title [data-stage]')?.dataset.stage ?? null,
      text: text(ws.querySelector('.conflict-file-title [data-stage]')),
    },
    wholeFile: !!ws.querySelector('.conflict-whole-file'),
    mergedLines: (ws.querySelector('.conflict-view')?.innerText.match(/Merged ·/g) ?? []).length,
    state: text(ws.querySelector('.conflict-state')),
    error: text(ws.querySelector('.conflict-error')) ?? text(ws.querySelector('.conflict-footer-status[data-error]')),
    footer: text(ws.querySelector('.conflict-footer-status')),
    primary: ws.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary ?? null,
    // Spills out of the dialog: a layout bug. Truncated with an ellipsis or clipped: worth a look.
    spill: watched.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > box.right + 0.5 || r.left < box.left - 0.5); }).map(name),
    truncated: watched.filter((e) => e.children.length === 0 && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible').map((e) => name(e) + ': ' + text(e)),
  };
})()`;

/** A case's per-block expectations for a file with `count` blocks (scripts/conflict-lab.mjs, expectedFor). */
function expectedList(spec: Expectation | undefined, count: number) {
  if (spec === undefined) return new Array<string>(Math.max(count, 1)).fill('any');
  return Array.isArray(spec) ? spec : new Array<string>(Math.max(count, 1)).fill(spec);
}
function matches(expected: string, actual: Bucket) {
  if (expected === 'any') return true;
  if (expected === 'auto') return actual === 'merged' || actual === 'clean';
  if (expected === 'any-but-merged') return actual !== 'merged';
  return expected === actual;
}
const count = (list: Bucket[], bucket: Bucket) => list.filter((b) => b === bucket).length;

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const contents = win.webContents;
  contents.on('console-message', (event) => {
    if (event.level === 'error') console.error(`[page] ${event.message}`);
  });
  const js = <T = unknown>(code: string) => contents.executeJavaScript(code) as Promise<T>;
  const until = async (code: string, what: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  // Mergiraf's hang case waits for the service's own timeout.
  const settle = () => waitSettled(contents, 'conflict-workspace', 120_000);
  const read = () => js<Screen>(READ);
  const shoot = async (file: string, dark = false) => {
    await js(`document.documentElement.classList.toggle('dark', ${dark})`);
    // The dialog's open animation and any transition have finished (spinners repeat forever and do not count).
    await until(
      "document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)",
      'animations to finish'
    );
    // Pixels only, never an assertion: the fonts are in and the theme change has reached a frame.
    await js(
      'document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))'
    );
    fs.mkdirSync(path.dirname(path.join(OUT, file)), { recursive: true });
    fs.writeFileSync(path.join(OUT, file), (await contents.capturePage()).toPNG());
    if (dark) await js("document.documentElement.classList.remove('dark')");
    return file;
  };
  const key = async (value: string) => {
    const code = `Key${value.toUpperCase()}`;
    const vk = value.toUpperCase().charCodeAt(0);
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: value,
      code,
      windowsVirtualKeyCode: vk,
      text: value,
    });
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: value,
      code,
      windowsVirtualKeyCode: vk,
    });
  };
  // A button by its name, without keyboard hints, inside `scope`.
  const button = (label: string, scope = 'document') =>
    `[...${scope}.querySelectorAll('button')].find((b) => { if (!b.checkVisibility()) return false; const c = b.cloneNode(true); c.querySelectorAll('kbd').forEach((k) => k.remove()); return c.textContent.trim() === ${JSON.stringify(label)}; })`;
  const has = (label: string, scope?: string) => js<boolean>(`!!(${button(label, scope)})`);
  const click = async (label: string, scope?: string) => {
    await until(`(${button(label, scope)}) && !(${button(label, scope)}).disabled`, `the ${label} button`);
    await js(`(${button(label, scope)}).click()`);
  };

  const server = spawn(path.resolve('node_modules/.bin/tsx'), ['scripts/conflict-gallery-server.mjs'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  const bridge = await new Promise<string>((resolve, reject) => {
    let out = '';
    server.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const port = /conflict-gallery (\d+)/.exec(out)?.[1];
      if (port) resolve(`http://127.0.0.1:${port}`);
    });
    server.on('exit', (code) => reject(new Error(`The gallery server exited (${code}) before it listened`)));
  });
  const post = async <T>(route: string, id: string) => {
    const response = await fetch(`${bridge}/${route}?id=${encodeURIComponent(id)}`, { method: 'POST' });
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(body.error);
    return body;
  };

  const results: Result[] = [];
  const interactions: { id: string; steps: { label: string; shot: string; note?: string }[]; problems: string[] }[] =
    [];
  const started = Date.now();
  const writeSheet = () => {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, interactions }, null, 2));
    fs.writeFileSync(path.join(OUT, 'index.html'), contactSheet(results, interactions, (Date.now() - started) / 1000));
  };

  try {
    // Only this suite's own output goes; the directory may hold other files.
    fs.mkdirSync(OUT, { recursive: true });
    for (const file of fs.readdirSync(OUT))
      if (/\.(png|html|json)$/.test(file) || file === 'interactions')
        fs.rmSync(path.join(OUT, file), { recursive: true, force: true });

    await loadWorkbenchPage(win, process.env.GNOSIS_WORKBENCH_URL ?? '');
    contents.debugger.attach('1.3');
    await contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await waitForWorkbenchQueue(contents);
    // The guide is open on first use; the gallery shows the workspace as people see it after that.
    await js("localStorage.setItem('gnosis-conflict-guide', 'dismissed')");
    await js(`(() => {
      window.conflictCalls = [];
      window.electronAPI.conflictResolution = async (request) => {
        window.conflictCalls.push(request.kind);
        if (/publish/.test(request.kind)) throw new Error('The conflict gallery never pushes.');
        const response = await fetch(${JSON.stringify(bridge)} + '/rpc?id=' + encodeURIComponent(window.galleryEntry), { method: 'POST', body: JSON.stringify(request) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error);
        return body;
      };
    })()`);
    const entries = (await (await fetch(`${bridge}/entries`)).json()) as Entry[];
    console.log(`Conflict gallery: ${entries.length} entries.`);

    for (const [n, entry] of entries.entries()) {
      const t0 = Date.now();
      const result: Result = { entry, files: [], summary: null, problems: [], notes: [], shots: [], seconds: 0 };
      results.push(result);
      try {
        const { url } = await post<{ url: string }>('open', entry.id);
        await js(`(async () => {
          window.galleryEntry = ${JSON.stringify(entry.id)};
          window.conflictCalls = [];
          const { setSyntaxLanguages } = await import('/lib/syntax-scope-client.ts');
          const off = ${JSON.stringify(entry.languagesOff)};
          setSyntaxLanguages((language) => !off.includes(language));
        })()`);
        await js(
          `window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts', { detail: ${JSON.stringify(url)} }))`
        );
        await settle();
        let screen = await read();
        const opened = screen;
        result.summary = screen.summary;
        if (screen.error) result.problems.push(`Error shown: ${screen.error}`);
        if (screen.summary?.includes('Checking'))
          result.problems.push(`Settled, but the summary still says: ${screen.summary}`);
        if (screen.wholeFile) result.notes.push('Shows a whole-file proposal.');
        result.shots.push(await shoot(`${entry.id}.png`));
        if (n % 4 === 0 || INTERACT.includes(entry.id)) result.shots.push(await shoot(`${entry.id}-dark.png`, true));

        // Each file: select it, wait, and read its blocks, header and file-list badge.
        const seen = new Map<string, { blocks: Bucket[]; row: FileRow; header: Screen['header'] }>();
        for (const row of screen.files) {
          if (!row.current) {
            await js(
              `[...document.querySelectorAll('nav.conflict-files > button')].find((b) => b.querySelector('span[title]')?.getAttribute('title') === ${JSON.stringify(row.path)}).click()`
            );
            await until(
              `document.querySelector('nav.conflict-files > button[aria-current=true] span[title]')?.getAttribute('title') === ${JSON.stringify(row.path)}`,
              `file ${row.path}`
            );
            await settle();
            screen = await read();
          }
          const current = screen.files.find((f) => f.current) ?? row;
          // A file that needs a local merge tool has one Decide and no blocks on screen.
          const blocks = current.limitation ? ['decide'] : screen.blocks;
          seen.set(row.path, { blocks, row: current, header: screen.header });
          for (const s of screen.spill) result.problems.push(`${row.path}: ${s} spills out of the dialog`);
          for (const t of screen.truncated) result.notes.push(`${row.path}: truncated ${t}`);
        }

        // Expectations, file by file.
        for (const [file, spec] of Object.entries(entry.expected))
          if (!seen.has(file)) {
            // Not in the workspace: Git merged it on its own, unless the workspace failed to open.
            const list = expectedList(spec, 1);
            const ok = !opened.error && list.every((e) => ['clean', 'auto', 'any'].includes(e));
            result.files.push({ path: file, expected: list, actual: [opened.error ? 'error' : 'clean'], ok });
            if (!ok && !opened.error)
              result.problems.push(`${file}: expected ${list.join(', ')}, but Git merged it with no conflict`);
          }
        for (const [file, { blocks, row, header }] of seen) {
          const spec = entry.expected[file];
          const expected = expectedList(spec, blocks.length);
          const ok =
            (!Array.isArray(spec) || spec.length === blocks.length) &&
            blocks.length > 0 &&
            blocks.every((b, i) => matches(expected[Math.min(i, expected.length - 1)], b));
          result.files.push({ path: file, expected, actual: blocks, ok });
          if (!ok)
            result.problems.push(`${file}: expected ${expected.join(', ')}, got ${blocks.join(', ') || 'no blocks'}`);
          if (
            expected.includes('any-but-merged') &&
            (blocks.includes('merged') || row.badges.some((b) => b.bucket === 'merged'))
          )
            result.problems.push(`${file}: shows Merged where any-but-Merged is expected`);
          // The file-list badge counts the blocks on screen.
          if (!row.limitation) {
            for (const bucket of ['decide', 'check', 'merged']) {
              const badge = row.badges.find((b) => b.bucket === bucket);
              const shown = badge ? Number(/^\d+/.exec(badge.text)?.[0]) : 0;
              if (shown !== count(blocks, bucket))
                result.problems.push(
                  `${file}: file list says ${badge?.text ?? `no ${bucket}`}, but ${count(blocks, bucket)} blocks are ${bucket}`
                );
            }
            const want = blocks.includes('decide') ? 'conflicted' : 'resolved';
            if (header.stage !== want)
              result.problems.push(
                `${file}: header badge says ${header.text ?? 'nothing'}, expected the ${want} stage`
              );
          }
        }
        // The summary agrees with the blocks of every file.
        const all = [...seen.values()].flatMap((s) => s.blocks);
        if (seen.size) {
          const s = result.summary ?? '';
          const files = Number(/^(\d+) files? conflicts?\./.exec(s)?.[1]);
          const merged = /(\d+) of (\d+) conflicts? (?:is|are) merged and checked/.exec(s);
          const needs = /Nothing needs you/.test(s) ? 0 : Number(/(\d+) needs? you/.exec(s)?.[1]);
          const want = {
            files: seen.size,
            merged: count(all, 'merged'),
            total: all.length,
            needs: count(all, 'decide') + count(all, 'check'),
          };
          if (!s) result.problems.push('No summary line');
          else {
            if (files !== want.files) result.problems.push(`Summary names ${files} files; the list has ${want.files}`);
            if ((merged ? Number(merged[1]) : 0) !== want.merged)
              result.problems.push(`Summary: "${s}", but ${want.merged} blocks are Merged`);
            if (merged && Number(merged[2]) !== want.total)
              result.problems.push(`Summary counts ${merged[2]} conflicts; the files have ${want.total}`);
            if (needs !== want.needs)
              result.problems.push(`Summary: "${s}", but ${want.needs} blocks are Check or Decide`);
          }
        } else result.notes.push(`No conflicted files: ${screen.state ?? screen.title ?? ''}`);

        if (INTERACT.includes(entry.id)) interactions.push(await interact(entry.id));
        await click('Close');
        await until("!document.querySelector('.conflict-workspace')", 'the workspace to close');
      } catch (error) {
        result.problems.push(`Failed: ${error instanceof Error ? error.message : String(error)}`);
        result.shots.push(await shoot(`${entry.id}.png`).catch(() => ''));
        // Leave a clean page for the next case.
        if (await js("!!document.querySelector('.conflict-workspace')")) {
          await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
          await click('Close').catch(() => {});
          await until("!document.querySelector('.conflict-workspace')", 'the workspace to close').catch(() => {});
        }
      } finally {
        await post('close', entry.id).catch(() => {});
        result.seconds = (Date.now() - t0) / 1000;
        console.log(
          `${result.problems.length ? '✖' : '✔'} ${entry.id} (${result.seconds.toFixed(1)} s)${result.problems.map((p) => `\n    ${p}`).join('')}`
        );
        writeSheet();
      }
    }

    /** Keys, Keep, Undo, the whole-file proposal, review and mark reviewed, up to the push confirmation. */
    async function interact(id: string) {
      const steps: { label: string; shot: string; note?: string }[] = [];
      const problems: string[] = [];
      const shot = async (label: string, note?: string) => {
        steps.push({
          label,
          note,
          shot: await shoot(
            `interactions/${id}-${String(steps.length + 1).padStart(2, '0')}-${label.replace(/\W+/g, '-').toLowerCase()}.png`
          ),
        });
      };
      const active = () => js<string | null>(ACTIVE);
      const first = (selector: string) => `document.querySelector('.conflict-view .conflict-block${selector}')`;
      try {
        await shot('opened', `focus on ${await active()}`);
        // J and K move between the blocks that need you (Decide and Check); with fewer than two, J goes to the
        // footer's next action.
        const pending = await js<number>(
          "document.querySelectorAll('.conflict-view .conflict-block:is([data-state=open],[data-bucket=check])').length"
        );
        const before = await active();
        await key('j');
        if (pending >= 2) await until(`(${JSON.stringify(before)}) !== (${ACTIVE})`, 'J to move');
        const afterJ = await active();
        await shot('j', `J: ${before} → ${afterJ}`);
        await key('k');
        if (pending >= 2) await until(`(${JSON.stringify(afterJ)}) !== (${ACTIVE})`, 'K to move');
        const afterK = await active();
        if (pending >= 2 && afterK !== before) problems.push(`K after J went to ${afterK}, not back to ${before}`);
        await shot('k', `K: ${afterJ} → ${afterK}`);

        if (await has('Resolve conflict by conflict instead', 'document')) {
          await js(
            `[...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Resolve conflict by conflict instead')).click()`
          );
          await settle();
          await shot('conflict-by-conflict');
        } else steps.push({ label: 'conflict-by-conflict', shot: '', note: 'No whole-file proposal on this build' });

        // Keep PR, Undo, Keep main, Undo, Keep both on the first block that offers them.
        const target = await js<string | null>(`${first(':has([data-choice=ours])')}?.dataset.conflictIndex ?? null`);
        if (target === null) {
          // Merged blocks only: Undo one, so it can be chosen again.
          const merged = await js<string | null>(`${first('[data-bucket=merged]')}?.dataset.conflictIndex ?? null`);
          if (merged !== null) {
            await js(
              `[...${first(`[data-conflict-index="${merged}"]`)}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Undo').click()`
            );
            await settle();
            await shot('undo-merged');
          }
        }
        const block = `document.querySelector('.conflict-view .conflict-block[data-conflict-index="${(await js<string | null>(`${first(':has([data-choice=ours])')}?.dataset.conflictIndex ?? null`)) ?? '0'}"]')`;
        for (const choice of ['ours', 'theirs', 'both'] as const) {
          if (!(await js(`!!${block}?.querySelector('[data-choice=${choice}]')`))) break;
          const was = await js<string>(`${block}.dataset.state + ' ' + (${block}.dataset.bucket ?? '')`);
          await js(`${block}.querySelector('[data-choice=${choice}]').click()`);
          await settle();
          const now = await js<string>(`${block}.dataset.state + ' ' + (${block}.dataset.bucket ?? '')`);
          const line = await js<string>(`${block}.innerText.split('\\n').slice(0, 2).join(' ')`);
          // A choice whose text equals the proposal shows as the proposal: the click seems to do nothing.
          if (now === was) problems.push(`Keep ${choice} changed nothing on screen: the block stays ${now.trim()}`);
          await shot(`keep-${choice}`, now.startsWith('kept') ? line : `shown as ${now.trim()}: ${line}`);
          if (choice === 'both') break;
          if (!now.startsWith('kept')) continue;
          await js(`[...${block}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Undo').click()`);
          await settle();
          await shot(
            `undo-${choice}`,
            await js<string>(`${block}.dataset.state + ' ' + (${block}.dataset.bucket ?? '')`)
          );
        }

        // Review each file and mark it reviewed, up to the push confirmation.
        for (let files = 0; files < 10 && !(await js("!!document.querySelector('.conflict-confirm')")); files++) {
          // Whatever is still open keeps the PR's side.
          for (let k = 0; k < 50 && (await js(`!!${first('[data-state=open]')}`)); k++) {
            await js(`${first('[data-state=open]')}.querySelector('[data-choice=ours]').click()`);
            await settle();
          }
          if (await has('Use this result')) {
            await click('Use this result');
            await settle();
            await shot('use-this-result');
          }
          await click('Review result', "document.querySelector('.conflict-modes')");
          await settle();
          await shot('review-result', (await read()).footer ?? '');
          const label = (await has('Mark reviewed & next file')) ? 'Mark reviewed & next file' : 'Mark reviewed';
          await click(label);
          await settle();
          if (label === 'Mark reviewed') {
            await until(
              "!!document.querySelector('.conflict-confirm') || document.querySelector('[data-conflict-primary]')?.dataset.conflictPrimary === 'confirm'",
              'the confirmation'
            );
            if (!(await js("!!document.querySelector('.conflict-confirm')"))) {
              await click('Review and push…');
              await settle();
            }
          } else await shot('next-file');
        }
        await until("!!document.querySelector('.conflict-confirm')", 'the push confirmation');
        await settle();
        // Whether the title and the Push button are on screen as the confirmation opens.
        const fold = await js<string>(`(() => {
          const where = (e) => {
            if (!e) return 'missing';
            const r = e.getBoundingClientRect();
            let top = 0, bottom = innerHeight;
            for (let p = e.parentElement; p; p = p.parentElement)
              if (/auto|scroll|hidden/.test(getComputedStyle(p).overflowY)) { const b = p.getBoundingClientRect(); top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom); }
            return r.top >= top - 0.5 && r.bottom <= bottom + 0.5 ? 'on screen' : 'off screen';
          };
          return 'Title ' + where(document.querySelector('.conflict-confirm h2')) + '; Push merge commit ' + where(${button('Push merge commit')}) + '.';
        })()`);
        await shot(
          'confirmation',
          `${fold} ${await js<string>("document.querySelector('.conflict-confirm-facts')?.innerText ?? ''")}`
        );
        if (!(await js<boolean>(`!!(${button('Push merge commit')})`)))
          problems.push('The confirmation has no Push merge commit button');
        if (await js<boolean>('window.conflictCalls.some((k) => /publish/.test(k))'))
          problems.push('Something tried to push');
        // Stop before the push.
        await click('Back to files');
        await settle();
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
        await shot('failure').catch(() => {});
      }
      console.log(`  interactions ${id}: ${steps.length} steps${problems.map((p) => `\n    ✖ ${p}`).join('')}`);
      return { id, steps, problems };
    }

    writeSheet();
    const failed = results.filter((r) => r.problems.length);
    console.log(
      `\nConflict gallery: ${results.length - failed.length} of ${results.length} cases pass; ${interactions.filter((i) => !i.problems.length).length} of ${interactions.length} interaction runs pass. Contact sheet: ${path.join(OUT, 'index.html')} (${((Date.now() - started) / 1000).toFixed(0)} s)`
    );
    server.kill();
    // A mismatch fails the suite, so a change to the resolver that moves a bucket is noticed.
    app.exit(failed.length || interactions.some((i) => i.problems.length) ? 1 : 0);
  } catch (error) {
    console.error(error);
    writeSheet();
    server.kill();
    app.exit(1);
  }
});

const escape = (s: string | number | undefined | null) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/** The page to review: every case with its expected and actual buckets, a pass or fail mark, and its screenshots. */
function contactSheet(
  results: Result[],
  interactions: { id: string; steps: { label: string; shot: string; note?: string }[]; problems: string[] }[],
  seconds: number
) {
  const failed = results.filter((r) => r.problems.length).length;
  const cards = results
    .map((r) => {
      const ok = !r.problems.length;
      const rows = r.files
        .map(
          (f) =>
            `<tr class="${f.ok ? '' : 'bad'}"><td>${escape(f.path)}</td><td>${escape(f.expected.join(', '))}</td><td>${escape(f.actual.join(', '))}</td></tr>`
        )
        .join('');
      const shots = r.shots
        .filter(Boolean)
        .map(
          (s) => `<a href="${escape(s)}" target="_blank"><img loading="lazy" src="${escape(s)}" alt="${escape(s)}"></a>`
        )
        .join('');
      return `<article class="${ok ? 'pass' : 'fail'}" id="${escape(r.entry.id)}">
<h2><span class="mark">${ok ? '✔' : '✖'}</span> ${escape(r.entry.id)}</h2>
<p class="meta">${escape([r.entry.category, r.entry.language, `${r.seconds.toFixed(1)} s`].filter(Boolean).join(' · '))}</p>
<p>${escape(r.entry.description)}</p>
<table><thead><tr><th>file</th><th>expected</th><th>actual</th></tr></thead><tbody>${rows}</tbody></table>
<p class="summary">${escape(r.summary ?? '')}</p>
${r.problems.length ? `<ul class="problems">${r.problems.map((p) => `<li>${escape(p)}</li>`).join('')}</ul>` : ''}
${r.notes.length ? `<details><summary>${r.notes.length} notes</summary><ul>${r.notes.map((p) => `<li>${escape(p)}</li>`).join('')}</ul></details>` : ''}
<div class="shots">${shots}</div></article>`;
    })
    .join('\n');
  const strips = interactions
    .map(
      (
        i
      ) => `<section class="strip ${i.problems.length ? 'fail' : 'pass'}"><h2>${i.problems.length ? '✖' : '✔'} ${escape(i.id)}</h2>
${i.problems.length ? `<ul class="problems">${i.problems.map((p) => `<li>${escape(p)}</li>`).join('')}</ul>` : ''}
<div class="steps">${i.steps
        .map(
          (s) =>
            `<figure>${s.shot ? `<a href="${escape(s.shot)}" target="_blank"><img loading="lazy" src="${escape(s.shot)}" alt="${escape(s.label)}"></a>` : '<div class="none">not shown</div>'}<figcaption><b>${escape(s.label)}</b> ${escape(s.note ?? '')}</figcaption></figure>`
        )
        .join('')}</div></section>`
    )
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Conflict gallery</title><style>
body{font:14px/1.4 system-ui,sans-serif;margin:24px;background:#f6f6f4;color:#1d1d1b}
header{display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}h1{margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(520px,1fr));gap:16px;margin-top:16px}
article,.strip{background:#fff;border:1px solid #ddd;border-left:6px solid #3a8a3a;border-radius:6px;padding:12px}
article.fail,.strip.fail{border-left-color:#c0392b}h2{font-size:15px;margin:0 0 4px;word-break:break-all}
.fail .mark{color:#c0392b}.pass .mark{color:#3a8a3a}.meta{color:#666;margin:0}
table{border-collapse:collapse;width:100%;font-size:12px}td,th{border-bottom:1px solid #eee;padding:2px 6px;text-align:left;word-break:break-all}
tr.bad td{background:#fdecea}.problems{color:#a02b1f;padding-left:18px}.summary{font-style:italic}
.shots{display:flex;gap:8px}.shots img{width:100%;max-width:480px;border:1px solid #ccc}
.steps{display:flex;gap:8px;overflow-x:auto}figure{margin:0;width:320px;flex:none}figure img{width:320px;border:1px solid #ccc}
figcaption{font-size:12px}.none{height:200px;display:grid;place-items:center;color:#888;border:1px dashed #ccc}
body.only-fail article.pass{display:none}
</style></head><body><header><h1>Conflict gallery</h1>
<p><b>${results.length - failed}</b> of ${results.length} cases pass · ${failed} fail · ${seconds.toFixed(0)} s</p>
<label><input type="checkbox" onchange="document.body.classList.toggle('only-fail',this.checked)"> Failures only</label></header>
${strips ? `<h2>Interactions</h2>${strips}` : ''}
<div class="grid">${cards}</div></body></html>`;
}
