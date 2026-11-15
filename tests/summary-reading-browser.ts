// Summary reading layout: a bounded prose measure, one column edge for prose and wide blocks, change
// counts beside the description, and metadata next to the text at laptop and wide window sizes.
import { loadWorkbenchPage, waitForWorkbenchQueue } from './workbench-ready';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}
interface Metrics {
  innerWidth: number;
  pageOverflow: boolean;
  contentOverflow: boolean;
  column: Box;
  markdown: Box;
  metadata: Box | null;
  heading: Box;
  stat: Box | null;
  prose: Box[];
  charsPerLine: number[];
  chipLines: number[];
  codeRight: number;
  measure: number;
  wide: number;
  bodyLeft: number;
  tableImages: Box[];
  tables: { wrapper: Box; table: Box; scrolls: boolean }[];
  images: Box[];
  blocks: Box[];
}

void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    useContentSize: true,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  window.webContents.on('console-message', (_event, _level, message) => console.log('renderer:', message));
  const js = <T = unknown>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (expression: string) => {
    for (let i = 0; i < 200; i++) {
      if (await js(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${expression}`);
  };
  const settle = () => js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const shots = path.resolve('.impeccable/review/summary-reading', process.env.SUMMARY_READING_PHASE ?? 'after');
  fs.mkdirSync(shots, { recursive: true });
  const capture = async (name: string) => {
    window.show();
    await js('document.fonts.ready');
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.writeFileSync(path.join(shots, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const resize = async (width: number, height: number) => {
    window.setContentSize(width, height);
    await wait(`innerWidth === ${width}`);
    await settle();
  };
  const metrics = () =>
    js<Metrics>(`(() => {
      const box = e => { const r = e.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) }; };
      const q = s => document.querySelector(s);
      const md = q('.pr-summary-page .pr-markdown');
      const content = q('.pr-summary-content');
      // Characters per full rendered line (the last line excluded) for plain paragraphs without code.
      const charsPerLine = [...md.querySelectorAll(':scope > p')].filter(p => !p.querySelector('code,img')).map(p => {
        const lines = new Map();
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let node = walker.nextNode(); node; node = walker.nextNode())
          for (let i = 0; i < node.length; i++) {
            range.setStart(node, i); range.setEnd(node, i + 1);
            const rect = range.getClientRects()[0];
            if (rect) lines.set(Math.round(rect.top), (lines.get(Math.round(rect.top)) ?? 0) + 1);
          }
        const counts = [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n).slice(0, -1);
        return counts.length >= 3 ? Math.round(counts.reduce((a, b) => a + b, 0) / counts.length) : 0;
      }).filter(Boolean);
      // Code chips must not push their lines apart: every line of a chip-heavy paragraph keeps the paragraph's leading.
      const chipLines = [...md.querySelectorAll(':scope > p')].filter(p => p.querySelectorAll('code').length >= 3).map(p => {
        const lh = parseFloat(getComputedStyle(p).lineHeight);
        return Math.round((p.getBoundingClientRect().height / lh) * 100) / 100;
      });
      return {
        innerWidth,
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        contentOverflow: content.scrollWidth > content.clientWidth,
        column: box(q('.pr-summary-page .pr-description')),
        markdown: box(md),
        metadata: q('.pr-summary-page .pr-metadata') ? box(q('.pr-summary-page .pr-metadata')) : null,
        heading: box(q('.pr-summary-page .pr-description-heading :is(h2,h3)')),
        stat: q('.pr-summary-page .pr-description-changes') ? box(q('.pr-summary-page .pr-description-changes')) : null,
        prose: [...md.querySelectorAll(':scope > :is(p,ul,ol,blockquote,.markdown-heading)')].filter(e => !e.querySelector('img,.markdown-image,.mermaid-diagram,.d2-diagram')).map(box),
        measure: parseFloat(getComputedStyle(document.documentElement).fontSize) * parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--measure-reading')),
        wide: parseFloat(getComputedStyle(document.documentElement).fontSize) * parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--measure-wide')),
        bodyLeft: Math.round(q('.pr-summary-body').getBoundingClientRect().left),
        tableImages: [...md.querySelectorAll('.pr-table-scroll img')].filter(i => i.checkVisibility()).map(box),
        charsPerLine,
        chipLines,
        codeRight: Math.round(Math.max(0, ...[...md.querySelectorAll(':not(pre) > code')].filter(c => !c.closest('.pr-table-scroll')).flatMap(c => [...c.getClientRects()].map(r => r.right)))),
        tables: [...md.querySelectorAll('table')].map(t => ({ wrapper: box(t.parentElement), table: box(t), scrolls: t.parentElement.scrollWidth > t.parentElement.clientWidth })),
        images: [...md.querySelectorAll('img')].filter(i => i.checkVisibility() && !i.closest('.pr-table-scroll')).map(box),
        blocks: [...md.querySelectorAll(':scope > :is(pre,details,hr,.mermaid-diagram,.d2-diagram)')].map(box),
      };
    })()`);
  const strict = process.env.SUMMARY_READING_PHASE !== 'before';
  const check = (name: string, m: Metrics) => {
    console.log(`summary-reading ${name}: ${JSON.stringify(m)}`);
    if (!strict) return;
    assert.equal(m.pageOverflow, false, `${name}: the window must not scroll horizontally`);
    assert.equal(m.contentOverflow, false, `${name}: the summary must not scroll horizontally`);
    const left = m.markdown.left;
    const proseEdge = left + Math.min(m.measure, m.markdown.width);
    // One left edge: the description starts where the status rows above it start.
    assert.ok(Math.abs(left - m.bodyLeft) <= 1, `${name}: description starts at ${left}, status rows at ${m.bodyLeft}`);
    // Prose track: the reading measure, from the shared left edge.
    for (const block of m.prose)
      assert.ok(
        Math.abs(block.left - left) <= 1 && block.right <= proseEdge + 1,
        `${name}: prose ${JSON.stringify(block)} leaves the prose track ${left}–${proseEdge}`
      );
    assert.ok(
      m.codeRight <= proseEdge + 1,
      `${name}: inline code reaches ${m.codeRight}, past the prose edge ${proseEdge}`
    );
    // Wide track: same left edge, never wider than the wide maximum or the column.
    assert.ok(m.markdown.width <= m.wide + 1, `${name}: the wide track is ${m.markdown.width}px, over ${m.wide}px`);
    for (const block of [...m.blocks, ...m.images, ...m.tables.map((t) => t.wrapper)])
      assert.ok(
        Math.abs(block.left - left) <= 15 && block.right <= m.markdown.right + 1,
        `${name}: wide block ${JSON.stringify(block)} leaves the wide track ${JSON.stringify(m.markdown)}`
      );
    if (m.innerWidth >= 1000) {
      // 62–78 characters per line (aiming for about 72), measured on the rendered text.
      for (const chars of m.charsPerLine)
        assert.ok(chars >= 62 && chars <= 78, `${name}: ${chars} characters per line is outside the reading measure`);
      for (const lines of m.chipLines)
        assert.ok(
          Math.abs(lines - Math.round(lines)) < 0.06,
          `${name}: inline code changes line spacing (${lines} lines)`
        );
      // Change counts end with the prose they introduce.
      if (m.stat)
        assert.ok(
          Math.abs(m.stat.right - proseEdge) <= 2,
          `${name}: change counts ${m.stat.right} detached from the prose edge ${proseEdge}`
        );
      // Metadata sits beside the prose (two-column mode) and no block runs under it.
      if (m.metadata && m.metadata.top < m.markdown.top + 200) {
        assert.ok(
          m.metadata.left - proseEdge <= 48 && m.metadata.left > proseEdge,
          `${name}: metadata ${m.metadata.left} is ${m.metadata.left - proseEdge}px from the prose edge ${proseEdge}`
        );
        const aside = m.metadata;
        for (const block of [...m.prose, ...m.blocks, ...m.images, ...m.tableImages, ...m.tables.map((t) => t.wrapper)])
          if (block.bottom > aside.top && block.top < aside.bottom && block.width > 0)
            assert.ok(
              block.right <= aside.left,
              `${name}: block ${JSON.stringify(block)} overlaps the metadata ${JSON.stringify(aside)}`
            );
      }
    }
    if (m.innerWidth >= 1600) {
      // Below the metadata, wide blocks use the whole wide track.
      const below = [...m.blocks, ...m.images, ...m.tables.map((t) => t.wrapper)].filter(
        (b) => b.width > 0 && (!m.metadata || b.top >= m.metadata.bottom)
      );
      for (const block of below)
        assert.ok(block.width >= 900, `${name}: a wide block below the metadata is only ${block.width}px wide`);
      // Wide content uses the wide track: tables fit without scrolling and screenshots stay legible.
      for (const table of m.tables.filter((t) => !m.metadata || t.wrapper.top >= m.metadata.bottom))
        assert.equal(table.scrolls, false, `${name}: a table scrolls despite the wide track`);
      for (const image of m.tableImages)
        assert.ok(image.width >= 400, `${name}: a screenshot in a table is only ${image.width}px wide`);
      if (m.tables.length)
        assert.ok(
          Math.max(...m.tables.map((t) => t.wrapper.width)) > m.measure + 1,
          `${name}: wide tables stay at the prose measure`
        );
    }
  };
  try {
    window.webContents.session.webRequest.onBeforeRequest(
      { urls: ['https://raw.githubusercontent.com/*', 'https://github.com/user-attachments/assets/*'] },
      (_details, callback) => callback({ cancel: true })
    );
    const fixtureUrl = process.env.GNOSIS_WORKBENCH_URL;
    if (!fixtureUrl) throw new Error('Missing workbench fixture URL');
    await loadWorkbenchPage(window, fixtureUrl + '?pr-summary&summary-reading');
    await waitForWorkbenchQueue(window.webContents);
    const open = async (title: string) => {
      await js(
        `[...document.querySelectorAll('.queue-row-main')].find(b=>b.textContent.includes(${JSON.stringify(title)})).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`
      );
      await wait(`document.querySelector('.pr-overview-heading h1')?.textContent.includes(${JSON.stringify(title)})`);
      await wait("!!document.querySelector('.pr-summary-page .pr-markdown')");
    };
    const back = async () => {
      await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await wait("!!document.querySelector('.queue-list')");
    };

    await open('Fix reconnect');
    for (const width of [1280, 1600, 1920]) {
      await resize(width, 1000);
      for (const theme of ['light', 'dark']) {
        await js(`document.documentElement.classList.toggle('dark', ${theme === 'dark'})`);
        await js("document.querySelector('.pr-summary-content').scrollTop = 0");
        check(`technical-${width}-${theme}`, await metrics());
        await capture(`technical-${width}-${theme}`);
      }
    }
    await js("document.querySelector('.pr-description details').open = true");
    assert.equal(
      await js<string>(
        "getComputedStyle(document.querySelector('.pr-description details table td:nth-child(2)')).textAlign"
      ),
      'right',
      'GFM column alignment reaches the rendered cells'
    );
    await js("document.querySelector('.pr-description details').scrollIntoView({block:'center'})");
    check('technical-details-1920-dark', await metrics());
    await capture('technical-details-1920-dark');
    await resize(540, 900);
    await js("document.querySelector('.pr-summary-content').scrollTop = 0");
    check('technical-540-dark', await metrics());
    await capture('technical-540-dark');

    // Wide blocks that start beside the metadata stay at the prose width instead of running under it.
    await resize(1600, 1000);
    await js("document.documentElement.classList.remove('dark')");
    await js(`(async()=>{
      const q=await window.electronAPI.workbenchQueue();
      const member=q.items.find(i=>i.subject.title.includes('Fix reconnect')).subject.members[0];
      const fence=String.fromCharCode(96).repeat(3);
      member.description = fence+'ts\\nconst beside = await ledger.claim(batch, { generation: session.generation, reason: "a deliberately long line that would run under the metadata" });\\n'+fence+'\\n\\n| Column one | Column two | Column three | Column four | Column five | Column six |\\n| --- | --- | --- | --- | --- | --- |\\n| A long cell that wants room | Another long cell | Third | Fourth | Fifth | Sixth |\\n\\n' + member.description;
    })()`);
    await wait(
      "document.querySelector('.pr-description .pr-markdown > pre')?.textContent.includes('deliberately long')"
    );
    await js("document.querySelector('.pr-summary-content').scrollTop = 0");
    check('wide-beside-metadata-1600-light', await metrics());
    await capture('wide-beside-metadata-1600-light');

    await resize(1280, 1000);
    await back();
    await open('Reduce allocations');
    await wait(
      "[...document.querySelectorAll('.pr-description img')].filter(i=>i.complete&&i.naturalWidth>0).length>=4"
    );
    for (const width of [1280, 1600, 1920]) {
      await resize(width, 1000);
      for (const theme of ['light', 'dark']) {
        await js(`document.documentElement.classList.toggle('dark', ${theme === 'dark'})`);
        await js("document.querySelector('.pr-summary-content').scrollTop = 0");
        check(`screenshots-${width}-${theme}`, await metrics());
        await capture(`screenshots-${width}-${theme}`);
        await js("document.querySelector('.pr-description table').scrollIntoView({block:'start'})");
        await capture(`screenshots-table-${width}-${theme}`);
      }
    }
    await resize(540, 900);
    await js("document.querySelector('.pr-description table').scrollIntoView({block:'start'})");
    check('screenshots-540-light', await metrics());
    await capture('screenshots-540-dark');
    console.log('Summary reading checks passed. Screenshots: ' + shots);
  } catch (error) {
    console.error(error);
    await capture('failure');
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.exit(Number(process.exitCode ?? 0));
  }
});
