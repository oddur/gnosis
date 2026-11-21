import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { LARGE_MOVES, MOVE_FILES } from './fixtures/moved-symbols';
import { assertPerf } from './perf-budget';

/**
 * Moved and renamed symbols (#398). `?moved-symbols` (tests/fixtures/moved-symbols.ts) moves functions between files,
 * renames one, moves one within its file, moves a C# method into a new class under a new name, and has a tie (two
 * removed copies of one method, one added) that must show nothing.
 *
 * - Each moved symbol has a note right above it: "Moved from src/moves/store.ts:35 · 1 line edited", "Moved to …",
 *   "renamed from parseHeader", "unchanged". The lines it carried over unchanged are dimmed; its real edit is not.
 * - The tie shows no note, on either side.
 * - A note sits right above its symbol's first line in unified and split diffs: after deleted rows, and on a hunk's
 *   first row, where it heads the hunk's code.
 * - A note's place is a link: to another file (Changes selects it and lands on the line), or within the file (the
 *   line is marked "here").
 * - An Explanation topic of the same files shows the same notes (AGENTS.md, diff parity).
 * - `?moved-symbols-large`: the cost on a large PR, printed as `MOVED SYMBOLS PERF`. Fingerprints run in the worker
 *   below every other parse; the match is one short task in the worker.
 *
 * With GNOSIS_MOVES_SHOTS=1 it prints `MOVESHOT <name> <base64 PNG>` lines.
 */
void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    useContentSize: true,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const errors: string[] = [];
  win.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error' && !message.includes('ResizeObserver')) errors.push(message);
  });
  const js = <T = unknown>(code: string) =>
    win.webContents.executeJavaScript(code).catch((error: unknown) => {
      throw new Error(code.slice(0, 400) + ': ' + String(error));
    }) as Promise<T>;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const wait = async (expression: string, tries = 300) => {
    for (let i = 0; i < tries; i++) {
      if (await js(expression)) return;
      await sleep(40);
    }
    throw Error(`Timed out: ${expression}\n${errors.join('\n')}`);
  };
  const click = async (label: string) => {
    await js(
      `(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.getBoundingClientRect().width&&(e.textContent.trim()===${JSON.stringify(label)}||e.getAttribute('aria-label')===${JSON.stringify(label)}));if(!e)throw Error('Missing '+${JSON.stringify(label)});e.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));e.click()})()`
    );
    await sleep(60);
  };
  const frames = 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))';
  const settle = async () => {
    await js(frames);
    await sleep(200);
    await js(frames);
  };
  const shots = !!process.env.GNOSIS_MOVES_SHOTS;
  const capture = async (name: string, selector: string) => {
    if (!shots) return;
    await settle();
    const r = await js<{ x: number; y: number; width: number; height: number }>(
      `(()=>{const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();const x=Math.max(0,Math.round(b.left)),y=Math.max(0,Math.round(b.top));return {x,y,width:Math.min(innerWidth-x,Math.round(b.width)),height:Math.min(innerHeight-y,Math.round(b.height))}})()`
    );
    console.log(`MOVESHOT ${name} ${(await win.webContents.capturePage(r)).toPNG().toString('base64')}`);
  };
  const row = (path: string) => `.commit-stream-row[data-file=${JSON.stringify(path)}]`;
  const install = () =>
    js(
      `window.deepAll=(s,r=document)=>r?[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>window.deepAll(s,e.shadowRoot))]:[];void 0`
    );
  const openChanges = async (query: string) => {
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?${query}`);
    await waitForWorkbenchQueue(win.webContents);
    await install();
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(e=>e.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await click('Changes');
  };
  /** Opens a file of the stream from the tree and waits until it has rendered its diff. */
  const openFile = async (path: string) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    await wait(`window.deepAll('[role=treeitem]').some(e=>e.getAttribute('aria-label')===${JSON.stringify(name)})`);
    await js(
      `window.deepAll('[role=treeitem]').find(e=>e.getAttribute('aria-label')===${JSON.stringify(name)}).click()`
    );
    await wait(`!!document.querySelector(${JSON.stringify(row(path) + ' .changes-diff')})`, 500);
  };
  /** A container's move notes, in order, as read: "Moved from src/moves/store.ts:35 · 1 line edited". */
  const notes = (scope: string) =>
    js<string[]>(
      `window.deepAll('[data-move-note]',document.querySelector(${JSON.stringify(scope)})).map(n=>n.textContent.replace(/\\s+/g,' ').replace(/ · /g,' · ').trim())`
    );
  /** Rows of a container's diff with a given text, dimmed as carried over by a move or not. */
  const rows = (scope: string) =>
    js<{ text: string; type?: string; moved: boolean }[]>(
      `window.deepAll('[data-line]',document.querySelector(${JSON.stringify(scope)})).filter(e=>e.dataset.lineType?.startsWith('change')).map(e=>({text:e.textContent,type:e.dataset.lineType,moved:e.hasAttribute('data-moved-line')}))`
    );
  const stats = () =>
    js<{
      prs: {
        url: string;
        skipped: boolean;
        families: {
          family: string;
          files: number;
          done: number;
          failed: number;
          state: string;
          moves?: number;
          compared?: number;
          capped?: boolean;
          matchMs?: number;
          candidates?: { before: number; after: number };
        }[];
      }[];
    }>(`import('/lib/moved-symbols-store.ts').then(m=>JSON.parse(JSON.stringify(m.movedSymbolsStats())))`);

  try {
    // ── Changes: every moved symbol says where it came from or went ──
    await openChanges('moved-symbols');
    await openFile(MOVE_FILES.queue);
    // The PR's files are fingerprinted below the breadcrumbs and matched once all are: the note lands after them.
    await wait(
      `window.deepAll('[data-move-note]',document.querySelector(${JSON.stringify(row(MOVE_FILES.queue))})).length>0`,
      750
    );
    const queueNotes = await notes(row(MOVE_FILES.queue));
    console.log('queue.ts notes:', JSON.stringify(queueNotes));
    assert.deepEqual(
      queueNotes,
      ['Moved from src/moves/store.ts:35 · 1 line edited'],
      'flushQueue says where it came from'
    );
    // Its eight lines carried over are dimmed; the edited weight line is a real edit and keeps its colour.
    const queueRows = await rows(row(MOVE_FILES.queue));
    const added = queueRows.filter((r) => r.type === 'change-addition');
    assert.equal(
      added.find((r) => r.text.includes('job.weight * 3'))?.moved,
      false,
      'The edited line keeps its colour'
    );
    assert.equal(added.filter((r) => r.moved).length, 8, `The lines carried over are dimmed: ${JSON.stringify(added)}`);
    assert.equal(
      await js(
        `window.deepAll('[data-move-note] [data-move-jump]',document.querySelector(${JSON.stringify(row(MOVE_FILES.queue))})).length`
      ),
      1,
      'The place is a link'
    );
    await capture('changes-moved-from', row(MOVE_FILES.queue));

    await openFile(MOVE_FILES.headers);
    await wait(
      `window.deepAll('[data-move-note]',document.querySelector(${JSON.stringify(row(MOVE_FILES.headers))})).length>0`,
      300
    );
    assert.deepEqual(
      await notes(row(MOVE_FILES.headers)),
      ['Moved from src/moves/store.ts:62 · renamed from parseHeader · body unchanged'],
      'A rename says its old name'
    );

    await openFile(MOVE_FILES.pump);
    await wait(
      `window.deepAll('[data-move-note]',document.querySelector(${JSON.stringify(row(MOVE_FILES.pump))})).length>0`,
      300
    );
    assert.deepEqual(
      await notes(row(MOVE_FILES.pump)),
      ['Moved from Runtime/Bridge.cs:7 · renamed from Drain · body unchanged'],
      'C#: a method moved into a new class, renamed'
    );

    await openFile(MOVE_FILES.store);
    await wait(
      `window.deepAll('[data-move-note]',document.querySelector(${JSON.stringify(row(MOVE_FILES.store))})).length>=4`,
      300
    );
    const storeNotes = await notes(row(MOVE_FILES.store));
    console.log('store.ts notes:', JSON.stringify(storeNotes));
    assert.deepEqual(
      [...storeNotes].sort(),
      [
        'Moved down from line 3 · unchanged',
        'Moved down to line 49 · unchanged',
        'Moved to src/moves/headers.ts:3 · renamed to readHeader · body unchanged',
        'Moved to src/moves/queue.ts:16 · 1 line edited',
      ],
      'The old side says where each symbol went, and the move within the file says both'
    );
    // The old side dims what a move carried over too: flushQueue's old body, but its edited weight line keeps its red.
    const oldFlush = `(()=>{const r=window.deepAll('[data-line]',document.querySelector(${JSON.stringify(row(MOVE_FILES.store))})).filter(e=>e.dataset.lineType==='change-deletion');const s=r.findIndex(e=>e.textContent.includes('export function flushQueue('));return r.slice(s,s+9).map(e=>({text:e.textContent,moved:e.hasAttribute('data-moved-line'),paint:getComputedStyle(e).backgroundImage}))})()`;
    await wait(`${oldFlush}.filter(r=>r.moved).length===8`, 300).catch(async (error: unknown) => {
      console.log('Old flushQueue rows:', JSON.stringify(await js(oldFlush)));
      throw error;
    });
    const oldRows = await js<{ text: string; moved: boolean; paint: string }[]>(oldFlush);
    const edited = oldRows.find((r) => r.text.includes('job.weight * 2'));
    console.log('Old flushQueue paint:', JSON.stringify(oldRows.map((r) => [r.moved, r.paint])));
    assert.equal(edited?.moved, false, 'The old side’s edited line keeps its colour');
    assert.ok(
      oldRows.every((r) => r === edited || (r.moved && r.paint !== edited?.paint)),
      'The old side’s carried-over lines are painted dimmed'
    );
    await capture('old-side-dimmed', row(MOVE_FILES.store));

    // ── A note sits right above its symbol: after deleted rows, and on a hunk's first row (#111) ──
    /**
     * A note's box and how far its bottom is above its symbol's first line (0 when right above it, negative when
     * below), once both are on screen and the layout holds across two reads.
     */
    const placed = async (path: string, note: string, type: string, line: string) => {
      const read = () =>
        js<string>(
          `(()=>{const s=document.querySelector(${JSON.stringify(row(path))});const n=window.deepAll('[data-move-note]',s).find(n=>n.textContent.includes(${JSON.stringify(note)}));const l=window.deepAll('[data-line]',s).find(e=>e.dataset.lineType===${JSON.stringify(type)}&&e.textContent.includes(${JSON.stringify(line)}));if(!n||!l)return '';const b=n.getBoundingClientRect(),r=l.getBoundingClientRect();if(!b.height||!r.height)return '';return JSON.stringify({gap:Math.round(r.top-b.bottom),bottom:Math.round(b.bottom),left:Math.round(b.left),right:Math.round(b.right),row:Math.round(s.getBoundingClientRect().left+s.getBoundingClientRect().width/2)})})()`
        );
      let last = '';
      for (let i = 0; i < 300; i++) {
        const now = await read();
        if (now && now === last)
          return JSON.parse(now) as { gap: number; bottom: number; left: number; right: number; row: number };
        last = now;
        await sleep(40);
      }
      throw Error(`${path}: "${note}" never settled above "${line}"`);
    };
    const layout = async (key: 'u' | 's') => {
      await js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}))`);
      await wait(
        `document.querySelector(${JSON.stringify(row(MOVE_FILES.lines))})?.closest('[data-diff-layout]')?.dataset.diffLayout===${JSON.stringify(key === 's' ? 'split' : 'unified')}`,
        200
      );
    };
    for (const [path, count] of [
      [MOVE_FILES.lines, 4],
      [MOVE_FILES.render, 2],
    ] as const) {
      await openFile(path);
      await wait(
        `window.deepAll('[data-move-note]',document.querySelector(${JSON.stringify(row(path))})).length===${count}`,
        300
      );
    }
    assert.deepEqual(
      [...(await notes(row(MOVE_FILES.lines)))].sort(),
      [
        'Moved to src/moves/render.ts:1 · renamed to renderLine · body unchanged',
        'Moved to src/moves/render.ts:7 · unchanged',
        'Moved up from line 18 · unchanged',
        'Moved up to line 1 · unchanged',
      ],
      'A move up the file says so'
    );
    assert.deepEqual([...(await notes(row(MOVE_FILES.render)))].sort(), [
      'Moved from src/moves/lines.ts:1 · unchanged',
      'Moved from src/moves/lines.ts:24 · renamed from formatLine · body unchanged',
    ]);
    for (const key of ['u', 's'] as const) {
      await layout(key);
      const name = key === 's' ? 'Split' : 'Unified';
      // Right above: under the row before it, or heading the hunk over the diff's top padding.
      const totalWidth = await placed(
        MOVE_FILES.lines,
        'Moved up from line 18',
        'change-addition',
        'export function totalWidth('
      );
      const normalize = await placed(
        MOVE_FILES.lines,
        'render.ts:7',
        'change-deletion',
        'export function normalizeLines('
      );
      const renderLine = await placed(
        MOVE_FILES.render,
        'renamed from formatLine',
        'change-addition',
        'export function renderLine('
      );
      for (const [label, at] of Object.entries({ totalWidth, normalize, renderLine })) {
        console.log(`${key} ${label}: note ${at.gap}px above its symbol`);
        assert.ok(at.gap >= 0 && at.gap <= 10, `${name}, ${label}: the note is right above its symbol (${at.gap}px)`);
      }
      // Split: the hunk's two lead notes share one row, each over its own column.
      if (key === 's') {
        assert.equal(normalize.bottom, totalWidth.bottom, 'Split: both notes heading the hunk end on one row');
        assert.ok(
          normalize.right <= normalize.row && totalWidth.left >= totalWidth.row,
          'Split: each note is in its column'
        );
      }
      for (const [file, path] of [
        ['lines', MOVE_FILES.lines],
        ['render', MOVE_FILES.render],
      ]) {
        if (!shots) continue;
        await openFile(path);
        await capture(`first-row-note-${key}-${file}`, row(path));
      }
    }
    // Split, narrower: the old side's lead note wraps to two lines (as on the Windows runner, whose 1024px screen clamps
    // the 1280px window), and the new side's still sits right above its first row, not at the top of the taller row.
    const wide = await js<number>('innerWidth');
    win.setContentSize(1000, 900);
    await wait('innerWidth===1000', 200);
    const wrapped = {
      totalWidth: await placed(MOVE_FILES.lines, 'Moved up from line 18', 'change-addition', 'export function totalWidth('),
      normalize: await placed(MOVE_FILES.lines, 'render.ts:7', 'change-deletion', 'export function normalizeLines('),
    };
    for (const [label, at] of Object.entries(wrapped)) {
      console.log(`s ${label} at 1000px: note ${at.gap}px above its symbol`);
      assert.ok(at.gap >= 0 && at.gap <= 10, `Split at 1000px, ${label}: the note is right above its symbol (${at.gap}px)`);
    }
    assert.equal(wrapped.normalize.bottom, wrapped.totalWidth.bottom, 'Split at 1000px: both lead notes end on one row');
    // Back to the width it had: 1280, or what a smaller screen clamped that to.
    win.setContentSize(wide, 900);
    await wait(`innerWidth===${wide}`, 200);
    await layout('u');

    // ── The tie: two removed copies of closeAll, one added: no note anywhere ──
    for (const path of [MOVE_FILES.base, MOVE_FILES.closeA]) {
      await openFile(path);
      await settle();
      assert.deepEqual(await notes(row(path)), [], `${path}: a tie shows no move`);
    }

    // ── A note's link goes to the other end: another file ──
    await openFile(MOVE_FILES.queue);
    await js(
      `window.deepAll('[data-move-jump]',document.querySelector(${JSON.stringify(row(MOVE_FILES.queue))}))[0].click()`
    );
    const flushLine = `window.deepAll('[data-line]',document.querySelector(${JSON.stringify(row(MOVE_FILES.store))})).find(e=>e.dataset.lineType==='change-deletion'&&e.textContent.includes('export function flushQueue('))`;
    await wait(
      `(()=>{const l=${flushLine};if(!l)return false;const s=document.querySelector('.commit-diff-stream').getBoundingClientRect();const r=l.getBoundingClientRect();return r.height>0&&r.top>=s.top&&r.bottom<=s.bottom})()`,
      500
    );
    console.log('Jump to another file: landed on store.ts flushQueue');
    // ── And within the file: formatEntry's new copy goes to its old line, marked "here" ──
    await js(
      `window.deepAll('[data-move-note]',document.querySelector(${JSON.stringify(row(MOVE_FILES.store))})).find(n=>n.textContent.includes('from line 3')).querySelector('[data-move-jump]').click()`
    );
    await wait(
      `window.deepAll('[data-here]',document.querySelector(${JSON.stringify(row(MOVE_FILES.store))})).some(e=>e.textContent.includes('export function formatEntry('))`,
      300
    );
    console.log('Jump within the file: marked formatEntry’s old line');

    // ── Parity: an Explanation topic of queue.ts and store.ts shows the same notes, in a session that never opens
    // Changes: the PR workspace tracks the PR's moves whichever tab shows its diffs. ──
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?moved-symbols`);
    await waitForWorkbenchQueue(win.webContents);
    await install();
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes('Introduce a bounded')).click()"
    );
    await wait("!!document.querySelector('.briefing-panel')");
    await click('Open AI explanation');
    await wait("!!document.querySelector('.explanation-reader')");
    await js(`window.selectOption('[aria-label="Explanation section"]', '1')`);
    assert.equal(await js('!!document.querySelector(".commit-diff-stream")'), false, 'Changes never opened');
    const topic = '[data-explanation-section="1"]';
    await wait(
      `window.deepAll('[data-move-note]',document.querySelector(${JSON.stringify(topic)})).length>=3`,
      1500
    ).catch(async (error: unknown) => {
      console.log('MOVES DEBUG', JSON.stringify(await stats()));
      throw error;
    });
    const topicNotes = await notes(topic);
    console.log('Topic notes:', JSON.stringify(topicNotes));
    for (const note of [
      ...queueNotes,
      'Moved to src/moves/queue.ts:16 · 1 line edited',
      'Moved down to line 49 · unchanged',
    ])
      assert.ok(topicNotes.includes(note), `The topic shows "${note}" as Changes does`);
    // The topic leaves out store.ts's third hunk: formatEntry's new copy and parseHeader's removal are not shown.
    assert.ok(
      !topicNotes.some((note) => /from line 3|readHeader/.test(note)),
      'Hunks the topic leaves out have no notes'
    );
    // The dimming lands once the topic's diff has the move's lines, which can be after its notes show.
    const dimmed = `window.deepAll('[data-line][data-moved-line]',document.querySelector(${JSON.stringify(topic)})).length`;
    await wait(`${dimmed}>=8`, 300).catch(async () => {
      assert.fail(`The topic dims the lines a move carried over, as Changes does: ${await js<number>(dimmed)} lines dimmed`);
    });
    await capture('explanation-moved-from', `${topic} .review-file-group`);

    // ── Summary alone reads nothing for moves: no file list, no contents, nothing tracked ──
    await loadWorkbenchPage(win, `${process.env.GNOSIS_WORKBENCH_URL}?moved-symbols-large`);
    await waitForWorkbenchQueue(win.webContents);
    await install();
    await js(`(()=>{window.fileReads=0;const api=window.electronAPI;const read=api.getPrChangeFile,after=api.getPrChangeFileAfter;
      api.getPrChangeFile=(...a)=>{window.fileReads++;return read(...a)};api.getPrChangeFileAfter=(...a)=>{window.fileReads++;return after(...a)};})()`);
    await js(
      "[...document.querySelectorAll('.queue-row-main')].find(e=>e.textContent.includes('Fix reconnect')).click()"
    );
    await click('Open PR overview');
    await sleep(4000);
    // `fileReads` counts every file read of the page (queue preparation too); `structureReads` counts the structure
    // queue's reads, which on Summary alone are the moves reads; `fingerprints`, the files fingerprinted.
    const summaryOnly = await js<{ reads: number; tracked: number; structureReads: number; fingerprints: number }>(
      `Promise.all([import('/lib/moved-symbols-store.ts'),import('/lib/use-syntax-contents.ts')]).then(([m,c])=>({reads:window.fileReads,tracked:m.movedSymbolsStats().prs.length,structureReads:c.syntaxContents.stats().reads,fingerprints:m.movedSymbolsStats().reads.reads}))`
    );
    console.log('SUMMARY ONLY', JSON.stringify(summaryOnly));
    assert.equal(summaryOnly.tracked, 0, 'Summary alone tracks no PR for moves');

    // ── Cost on a large PR ──
    await openChanges('moved-symbols-large');
    await js(
      `window.longTasks=[];new PerformanceObserver(l=>window.longTasks.push(...l.getEntries().map(e=>Math.round(e.duration)))).observe({type:'longtask'});void 0`
    );
    const started = Date.now();
    await wait(`window.deepAll('.diff-gap-scope:not([data-provisional])').length>0`, 750);
    const firstScope = Date.now() - started;
    let large: Awaited<ReturnType<typeof stats>>['prs'][number] | undefined;
    for (let i = 0; i < 240; i++) {
      large = (await stats()).prs.find((pr) => pr.families.some((f) => f.files >= 50));
      if (large?.families.every((f) => f.state === 'matched' || f.state === 'incomplete')) break;
      await sleep(250);
    }
    const matchedAfter = Date.now() - started;
    const totals = await js<{ reads: number; ms: number; maxMs: number; waitMs: number; parses: number }>(
      `import('/lib/syntax-scope-client.ts').then(m=>({...m.symbolReadTotals,parses:m.syntaxWorkerParses()}))`
    );
    const longTasks = await js<number[]>('window.longTasks');
    const families = large?.families ?? [];
    console.log(
      'MOVED SYMBOLS PERF',
      JSON.stringify({
        files: 240,
        fingerprinted: families.reduce((n, f) => n + f.done, 0),
        families: families.map((f) => ({
          family: f.family,
          files: f.files,
          state: f.state,
          moves: f.moves,
          candidates: f.candidates,
          compared: f.compared,
          matchMs: f.matchMs,
        })),
        workerMs: {
          total: Math.round(totals.ms),
          max: Math.round(totals.maxMs),
          perFile: Math.round(totals.ms / Math.max(1, totals.reads)),
          queueWait: Math.round(totals.waitMs / Math.max(1, totals.reads)),
        },
        // Every parse the worker made: breadcrumbs, comparisons and moved symbols together.
        workerParses: totals.parses,
        fingerprintReads: totals.reads,
        firstBreadcrumbMs: firstScope,
        matchedAfterMs: matchedAfter,
        longTasks,
      })
    );
    assert.ok(large && !large.skipped, 'The large PR is matched');
    assert.ok(
      families.every((f) => f.state === 'matched'),
      `Every family is matched: ${JSON.stringify(families)}`
    );
    assert.equal(
      families.reduce((n, f) => n + (f.moves ?? 0), 0),
      LARGE_MOVES,
      'Every move of the large PR is found, and nothing else'
    );
    // Each match is one short task in the worker (tests/perf-budget.ts: enforced by npm run test:perf, reported on CI).
    for (const f of families) assertPerf(`moved symbols: ${f.family} match in the worker`, f.matchMs ?? NaN, 100);
    assert.equal(errors.filter((e) => !/favicon/.test(e)).length, 0, errors.join('\n'));
    console.log('Moved symbols checks passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
