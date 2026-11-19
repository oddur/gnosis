import { loadWorkbenchPage } from './workbench-ready';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { chooseWorkspaceMenuItem } from './workspace-menu';

/**
 * Activity after AI provider trouble: a usage limit shows one notice instead of a failed row per PR,
 * and Clear failed removes failed rows while the notice and other work stay.
 */
void app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 760, show: true, webPreferences: { backgroundThrottling: false } });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string) => {
    for (let i = 0; i < 150; i++) {
      if (await js(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error(`Timed out: ${code}`);
  };
  try {
    const url = process.env.GNOSIS_WORKBENCH_URL;
    if (!url) throw Error('Missing fixture URL');
    await loadWorkbenchPage(win, url);
    await wait("!!document.querySelector('.queue-item')");
    await js(`(()=>{
      const at = new Date(Date.now() - 60_000).toISOString();
      const failed = (id, title, detail, kind = 'briefing') => ({ id, kind, title, detail, model: 'gpt-6.2-astra', status: 'failed', updatedAt: at, canCancel: false, canRetry: true });
      window.fixtureTasks = [
        { id: 'briefing-pause:codex', kind: 'briefing', title: 'Automatic briefings paused', model: 'gpt-6.2-astra', status: 'paused',
          detail: 'Codex usage limit reached. Automatic briefings resume at 1:25 PM. You can still generate one manually.',
          updatedAt: at, canCancel: false, canRetry: true },
        failed('briefing:a', 'ci: rebuild the CI runner images', 'Codex did not finish the briefing within 90 seconds. Retry this briefing.'),
        failed('briefing:b', 'Bound the worker queue', 'GitHub was too slow to load this PR for a briefing. Retry this briefing.'),
        failed('review:c', 'Boot checks for the published images', '1 of 2 topics saved. Retry this explanation to reuse completed topics.', 'review'),
        { id: 'review:done', kind: 'review', title: 'Review transport shutdown', detail: 'Review ready', reviewId: 'workbench-review', model: 'gpt-6.2-astra', status: 'completed', updatedAt: at, canCancel: false, canRetry: false },
      ];
      window.fixtureActions = [];
      window.electronAPI.listActivity = () => Promise.resolve(structuredClone(window.fixtureTasks));
      window.electronAPI.activityAction = (id, action) => {
        window.fixtureActions.push(id + ':' + action);
        if (id.startsWith('briefing-pause:') && action === 'retry') window.fixtureTasks = window.fixtureTasks.filter((t) => t.id !== id);
        return Promise.resolve();
      };
      window.electronAPI.clearFailedActivity = () => {
        window.fixtureActions.push('clear-failed');
        window.fixtureTasks = window.fixtureTasks.filter((t) => t.status !== 'failed');
        return Promise.resolve();
      };
    })()`);
    await js(chooseWorkspaceMenuItem('[data-activity]'));
    await wait("document.querySelectorAll('.activity-task').length===5");
    const notices = await js<string[]>(
      "[...document.querySelectorAll('.activity-task')].filter(row=>row.textContent.includes('usage limit')).map(row=>row.textContent)"
    );
    assert.equal(notices.length, 1, 'one limit notice, not a failed row per PR');
    assert.match(notices[0], /Automatic briefings paused.*Codex usage limit reached\. Automatic briefings resume at 1:25 PM\./);
    assert.equal(await js("document.querySelector('.activity-summary').textContent"), '1 paused · 3 failed · 1 ready');
    // The pause can last hours, so it never shows as running work in the title bar capsule.
    assert.doesNotMatch(await js<string>("document.querySelector('.activity-capsule')?.getAttribute('aria-label') ?? ''"), /running/);
    const clear = "[...document.querySelectorAll('.activity-drawer header button')].find(b=>b.textContent==='Clear failed')";
    assert.ok(await js(`!!${clear}`), 'Clear failed is offered while failures are listed');
    fs.writeFileSync(path.join(os.tmpdir(), 'gnosis-ai-job-activity.png'), (await win.webContents.capturePage()).toPNG());
    await js(`${clear}.click()`);
    await wait("document.querySelectorAll('.activity-task').length===2");
    assert.deepEqual(await js("window.fixtureActions"), ['clear-failed']);
    assert.equal(await js(`!!${clear}`), false, 'Clear failed leaves with the failures');
    assert.equal(await js("document.querySelector('.activity-summary').textContent"), '1 paused · 1 ready');
    // Retry on the notice resumes automatic briefings early.
    await js("[...document.querySelectorAll('.activity-task')].find(row=>row.textContent.includes('usage limit')).querySelector('.activity-actions button').click()");
    await wait("![...document.querySelectorAll('.activity-task')].some(row=>row.textContent.includes('usage limit'))");
    assert.deepEqual(await js("window.fixtureActions"), ['clear-failed', 'briefing-pause:codex:retry']);
    console.log('AI job Activity passed: one usage-limit notice, quiet capsule, Clear failed, resume from the notice.');
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    win.destroy();
    app.exit(1);
  }
});
