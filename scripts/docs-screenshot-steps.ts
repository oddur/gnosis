// Named step functions for documentation screenshots whose scenes need more than the simple steps in
// scripts/docs-screenshots.json: fixture mocks, shadow-DOM clicks, filled fields. A recipe names one with "scene"; it
// runs after the recipe's simple steps and before its "ready" condition. Each function drives the fixture page through
// the context only, and waits on conditions, never on time (AGENTS.md). The setups follow the browser suites named
// beside each scene, which check the same screens.
//
// This module must stay free of Electron imports: tests/docs-screenshots.test.ts loads it to check recipe names.

export interface SceneContext {
  /** The recipe being captured, for error messages. */
  recipe: string;
  theme: 'light' | 'dark';
  /** Runs an expression in the page and returns its value (awaited when it is a promise). */
  js<T = unknown>(expression: string): Promise<T>;
  /** Runs one simple step, written as in the recipes file ("click text:Merge", "wait .x", "key Mod+K"). */
  step(step: string): Promise<void>;
  /** Waits until a synchronous page expression is truthy; fails naming `what` after the timeout. */
  until(expression: string, what: string, timeoutMs?: number): Promise<void>;
}

export type Scene = (context: SceneContext) => Promise<void>;

const q = (value: string) => JSON.stringify(value);

/** The seven queue items of tests/fixtures/workbench.tsx have rendered (tests/workbench-ready.ts waitForWorkbenchQueue). */
async function queue(c: SceneContext) {
  await c.until(`document.querySelectorAll('.queue-item').length===7`, 'the queue to list its seven fixture PRs', 60_000);
}

/** Selects the queue row whose text includes `title` (a single click selects; it opens the briefing panel). */
async function selectRow(c: SceneContext, title: string) {
  const row = `[...document.querySelectorAll('[data-workspace-active=true] .queue-row-main, .queue-row-main')].find(b=>b.textContent.includes(${q(title)}))`;
  await c.until(row, `the queue row "${title}"`);
  await c.js(`${row}.click()`);
}

/** Clicks the visible element under `scope` whose text or aria-label is `text`, as the suites click (mousedown first). */
async function clickIn(c: SceneContext, scope: string, text: string) {
  const find = `window.__docs.all(${q(scope)}).filter(window.__docs.visible).find(e=>e.textContent.trim()===${q(text)}||e.getAttribute('aria-label')===${q(text)})`;
  await c.until(find, `"${text}" in ${scope}`);
  await c.js(`window.__docs.press(${find})`);
}

/** Opens a PR's overview from the queue (tests/pr-changes-browser.ts, pr-actions-browser.ts). */
async function openPr(c: SceneContext, title = 'Fix reconnect') {
  await queue(c);
  await selectRow(c, title);
  await c.step('click text:Open PR overview');
  await c.step('wait [data-workspace-active=true] .pr-overview-tabs');
}

/** Switches the PR page to one of its tabs: Summary, Changes, Commits, Checks, Explanation, Local notes. */
async function prTab(c: SceneContext, label: string) {
  await clickIn(c, '[data-workspace-active=true] .pr-overview-tabs [role=tab]', label);
  await c.until(
    `document.querySelector('[data-workspace-active=true] .pr-overview-tabs [role=tab][data-state=active]')?.textContent.trim()===${q(label)}`,
    `the ${label} tab to be active`
  );
}

/** Opens a file in Changes from the file tree, which lives in a shadow root (tests/pr-changes-browser.ts). */
async function openFile(c: SceneContext, name: string, path: string) {
  await c.step('wait .changes-file-tree');
  const item = `window.__docs.all('[role=treeitem]').find(e=>e.getAttribute('aria-label')===${q(name)})`;
  await c.until(item, `the file tree item ${name}`);
  await c.js(`${item}.click()`);
  await c.until(`!!document.querySelector('.commit-stream-row[data-file=${q(path)}] .changes-diff')`, `the diff of ${path}`, 30_000);
}

/** Opens the stack's AI explanation and goes to a section (tests/explanation-tab-browser.ts, d2-browser.ts). */
async function openExplanation(c: SceneContext, section?: number) {
  await queue(c);
  await c.until(`document.querySelector('.queue-item:has(.queue-disclosure:not(:disabled)) .queue-row-main')`, 'the stack row');
  await c.js(`document.querySelector('.queue-item:has(.queue-disclosure:not(:disabled)) .queue-row-main').click()`);
  await c.step('click text:Open AI explanation');
  await c.step('wait .explanation-reader');
  if (section !== undefined) {
    await c.until(`document.querySelector('[aria-label="Explanation section"]')`, 'the explanation section picker');
    await c.js(`window.selectOption('[aria-label="Explanation section"]', ${q(String(section))})`);
    await c.until(`document.querySelector('[aria-label="Explanation section"]')?.value===${q(String(section))}`, `explanation section ${section}`);
  }
}

/** Sets a text field's value as a person typing would, so React sees the change. */
async function fill(c: SceneContext, selector: string, text: string) {
  await c.until(`document.querySelector(${q(selector)})`, selector);
  await c.js(
    `(()=>{const e=document.querySelector(${q(selector)});e.focus();const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${q(text)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`
  );
}

/** Mocks for the PR header actions; every write stays in the page (tests/pr-actions-browser.ts). */
async function prActionMocks(c: SceneContext) {
  await c.js(`(async()=>{
    const q=await window.electronAPI.workbenchQueue();
    window.actionState=url=>{const m=q.items.flatMap(i=>i.subject.members).find(m=>m.url===url);if(!m)throw Error('Unknown fixture PR');return {...m,account:'oddur',id:'PR_'+m.number,checkedAt:Date.now(),state:'OPEN',headRepo:m.repo,repository:m.repo,archived:false,canWrite:true,mergeable:'MERGEABLE',mergeState:'CLEAN',reviewDecision:'APPROVED',checkState:'SUCCESS',methods:['SQUASH','MERGE','REBASE'],defaultMethod:'SQUASH',autoMerge:null,canEnableAuto:true,canDisableAuto:true,canUpdateBranch:true,canChangeDraft:true,mergeQueue:false,inMergeQueue:false,stack:null};};
    const status=window.electronAPI.getPrStatus;
    window.electronAPI.getPrStatus=async(...args)=>{const r=await status(...args);const s=window.actionState(args[0]);return {...r,isDraft:s.isDraft,signals:{...r.signals,checkedAt:Date.now(),readiness:{...r.signals.readiness,isDraft:s.isDraft,mergeable:s.mergeable,mergeState:s.mergeState}}};};
    window.electronAPI.getPrActionState=async url=>window.actionState(url);
    window.electronAPI.conflictHeader=async()=>null;
    window.electronAPI.onConflictHeaderChanged=()=>()=>{};
    window.electronAPI.performPrAction=async()=>({status:'completed',message:'GitHub action completed.'});
    return true;
  })()`);
}

/** The PR header with every action in its row: wider than 1280, so nothing collapses into the overflow menu. */
async function prHeader(c: SceneContext) {
  await queue(c);
  await prActionMocks(c);
  await openPr(c);
  await c.until(
    `(()=>{const a=document.querySelector('[data-workspace-active=true] .pr-header-actions');const m=a?.querySelector('[data-merge-action]');return !!m&&m.getAttribute('aria-disabled')!=='true'&&a.dataset.collapse==='0'})()`,
    'the PR header actions to load, uncollapsed'
  );
}

/** Opens a Settings section (tests/repository-settings-browser.ts: Cmd/Ctrl+, then Enter on the section tab). */
async function settings(c: SceneContext, label: string) {
  await queue(c);
  await c.step('key Mod+,');
  await c.step('wait .settings-tabs');
  const tab = `[...document.querySelectorAll('.settings-sections [role=tab]')].find(t=>t.textContent.trim()===${q(label)})`;
  await c.until(tab, `the Settings section tab "${label}"`);
  await c.js(`${tab}.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await c.until(
    `document.querySelector('.settings-sections [role=tab][data-state=active]')?.textContent.trim()===${q(label)}`,
    `the Settings section "${label}" to be active`
  );
}

const settingsScene =
  (label: string): Scene =>
  (c) =>
    settings(c, label);

export const scenes: Record<string, Scene> = {
  /** A PR selected in the queue, with its briefing beside it. */
  async queueSelected(c) {
    // No settled:queue-list wait: that key is registered only when the queue is long enough to be virtual.
    await queue(c);
    await selectRow(c, 'Introduce a bounded');
  },

  /** The command palette searching for a PR number (tests/command-center-browser.ts). */
  async commandPalette(c) {
    await queue(c);
    await c.step('key Mod+K');
    await c.step('wait .global-command-dialog input[role=combobox]');
    await fill(c, '.global-command-dialog input[role=combobox]', '#150');
  },

  /** Four workspace tabs: the queue and three PRs opened in the background with Cmd/Ctrl+click; the second is active. */
  async workspaceTabs(c) {
    await queue(c);
    await c.js(
      `[...document.querySelectorAll('[data-workspace-active=true] .queue-row-main')].slice(1,4).forEach(b=>b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0,metaKey:true})))`
    );
    await c.until(`document.querySelectorAll('.workspace-tab').length===4`, 'four workspace tabs');
    await c.js(`document.querySelectorAll('.workspace-tab-select')[1].click()`);
    await c.step('wait [data-workspace-active=true] .pr-summary-page');
  },

  /** The Open tabs menu, over the tabs of workspaceTabs (tests/workspace-tabs-hardening-browser.ts). */
  async workspaceTabsMenu(c) {
    await scenes.workspaceTabs(c);
    await c.step('click [aria-label="Open tabs"]');
  },

  async prSummary(c) {
    await openPr(c);
    await c.step('wait [data-workspace-active=true] .pr-description');
  },

  /** Changes in the split layout: `s` sets it (lib/diff-layout.ts DIFF_LAYOUT_KEYS.split). */
  async changesSplit(c) {
    await openPr(c);
    await prTab(c, 'Changes');
    await openFile(c, 'worker.ts', 'src/worker.ts');
    await c.js(`document.activeElement?.blur()`);
    await c.step('key s');
  },

  async commits(c) {
    await openPr(c);
    await prTab(c, 'Commits');
  },

  /** Checks as a workflow graph (tests/pr-checks-browser.ts, workflow-graph-browser.ts). */
  async checksGraph(c) {
    await openPr(c);
    await prTab(c, 'Checks');
    await c.until(`document.querySelectorAll('.check-row').length>=6`, 'the check rows');
    await c.step('click text:Graph');
  },

  /** A failing check opened in the list, with its steps (tests/workflow-graph-browser.ts). */
  async checksFailure(c) {
    await openPr(c);
    await prTab(c, 'Checks');
    await c.until(`document.querySelectorAll('.check-row').length>=6`, 'the check rows');
    await c.js(`[...document.querySelectorAll('.check-row')].find(b=>b.textContent.includes('Lint')).click()`);
  },

  async localNotes(c) {
    await openPr(c);
    await prTab(c, 'Local notes');
  },

  /** A draft inline comment on a changed line (tests/pr-changes-browser.ts, comments-composer capture). */
  async inlineComment(c) {
    await openPr(c);
    await prTab(c, 'Changes');
    await openFile(c, 'worker.ts', 'src/worker.ts');
    const line = `window.__docs.all('[data-column-number]',document.querySelector('.commit-stream-row[data-file="src/worker.ts"]')).find(e=>e.getAttribute('data-column-number')==='36'&&e.getAttribute('data-line-type')==='change-addition')`;
    await c.until(line, 'line 36 of src/worker.ts');
    await c.js(`${line}.click()`);
    await c.step('wait .changes-comment-composer textarea');
    await fill(c, '.changes-comment-composer textarea', 'Keep the cancellation boundary explicit: a late acknowledgement should not resurrect a cancelled command.');
    await c.js(`document.querySelector('.changes-comment-composer').scrollIntoView({block:'center'})`);
  },

  /** Review threads in an explanation section, with Reply and Resolve (tests/review-threads-browser.ts). */
  async reviewThreads(c) {
    await openExplanation(c, 1);
    await c.until(`document.querySelectorAll('.github-thread').length===5`, 'the five fixture threads');
    await c.step('click text:View 2 threads below diff');
    await c.js(`document.querySelector('.github-discussion-toolbar')?.scrollIntoView({block:'center'})`);
  },

  async prHeader(c) {
    await prHeader(c);
  },

  /** The merge confirmation: Cmd/Ctrl+Shift+M (components/PrActions.tsx). */
  async mergeConfirm(c) {
    await prHeader(c);
    await c.js(`document.activeElement?.blur()`);
    await c.step('key Mod+Shift+M');
  },

  /** The Update menu: Cmd/Ctrl+Shift+U. */
  async updateMenu(c) {
    await prHeader(c);
    await c.js(`document.activeElement?.blur()`);
    await c.step('key Mod+Shift+U');
  },

  /** Review PR, to approve, comment or request changes: Cmd/Ctrl+Shift+V. */
  async submitReview(c) {
    await prHeader(c);
    await c.js(`document.activeElement?.blur()`);
    await c.step('key Mod+Shift+V');
  },

  async explanationSection(c) {
    await openExplanation(c, 1);
  },

  /** Focused sections: a slice with labelled gaps (tests/explanation-parity-browser.ts, section 4). */
  async focusedSection(c) {
    await openExplanation(c, 4);
  },

  /** "Code outside the explanation", listed at the end of a focused explanation. */
  async outsideCode(c) {
    await openExplanation(c, 4);
    await c.step('click .explanation-outside-code summary');
    await c.step('wait .explanation-outside-code li li button');
    await c.step('scroll .explanation-outside-code');
  },

  /** A D2 diagram in an explanation section; the fixture review gets one of the D2 gallery's examples (tests/d2-browser.ts). */
  async d2Explanation(c) {
    await queue(c);
    await c.js(`(async()=>{
      const {D2_EXAMPLES}=await import('/tests/fixtures/d2-examples.ts');
      const load=window.electronAPI.loadReview;
      window.electronAPI.loadReview=async(...args)=>{const review=await load(...args);const diagram=structuredClone(D2_EXAMPLES[0].diagram);const h=review.slides[0].diffHunks[0];diagram.steps[0].evidence={filePath:h.filePath,startLine:parseInt(h.hunkHeader.split('+')[1])};return {...review,slides:[{...review.slides[0],title:'Architecture with annotations',d2Diagram:diagram,mermaidDiagram:null}]};};
      return true;
    })()`);
    await openExplanation(c, 1);
  },

  /** The section chat beside an explanation: `c` opens it (tests/chat-browser.ts, integrated-topic capture). */
  async sectionChat(c) {
    await queue(c);
    await c.js(
      `window.electronAPI.sendSlideChat=async()=>'The queue bounds work **before** it reaches the worker: \`enqueue\` waits for capacity, so a slow worker slows producers instead of growing memory.\\n\\n- Cancellation releases the slot it held.\\n- Retries go back through the same bound.'`
    );
    await openExplanation(c, 1);
    await c.js(`document.activeElement?.blur()`);
    await c.step('key c');
    await c.step('wait .chat-sheet textarea');
    await fill(c, '.chat-sheet textarea', 'Why does the queue need a bound?');
    await c.step('click text:Send question');
  },

  /** File chat in Changes: "Ask about this" on a file header (tests/chat-browser.ts, integrated-file capture). */
  async fileChat(c) {
    await openPr(c);
    await prTab(c, 'Changes');
    await c.step('wait .commit-stream-row');
    await clickIn(c, '.changes-file-header button', 'Ask about this');
    await c.until(`document.activeElement?.id==='changes-question'`, 'the file question field');
    await fill(c, '#changes-question', 'What happens to a command that is cancelled while it waits?');
    await c.step('click text:Send question');
  },

  /** The conflicts view for PR #120, with a session the page mocks (tests/conflict-resolution-browser.ts). */
  async conflicts(c) {
    await queue(c);
    await c.js(`(()=>{
      const original='export function retryDelay(attempt: number) {\\n<<<<<<< feature/retry\\n  return Math.min(attempt * 200, 5000);\\n||||||| ancestor\\n  return attempt * 200;\\n=======\\n  return Math.max(100, attempt * 200);\\n>>>>>>> main\\n}\\n<<<<<<< feature/retry\\nexport const retries = 5;\\n=======\\nexport const retries = 3;\\n>>>>>>> main\\n';
      window.conflictFixture={id:'a'.repeat(64),account:'oddur',url:'https://github.com/klang/engine/pull/120',title:'Bound retry delays',headRepo:'klang/engine',baseRepo:'klang/engine',headBranch:'feature/retry',baseBranch:'main',headSha:'a'.repeat(40),baseSha:'b'.repeat(40),tree:'c'.repeat(40),version:1,status:'editing',files:[{path:'src/retry.ts',mode:'100644',base:'export function retryDelay(attempt: number) {\\n  return attempt * 200;\\n}\\nexport const retries = 4;\\n',ours:'export function retryDelay(attempt: number) {\\n  return Math.min(attempt * 200, 5000);\\n}\\nexport const retries = 5;\\n',theirs:'export function retryDelay(attempt: number) {\\n  return Math.max(100, attempt * 200);\\n}\\nexport const retries = 3;\\n',original,result:original,resolved:false,source:'manual'}]};
      window.electronAPI.conflictTypeCheck=async()=>null;
      window.electronAPI.cancelConflictTypeCheck=async()=>{};
      window.electronAPI.onConflictTypeCheckChanged=()=>()=>{};
      window.electronAPI.conflictResolution=async req=>{const s=window.conflictFixture;if(req.kind==='open')return {session:structuredClone(s)};if(req.kind==='preview')return {session:structuredClone(s),preview:{token:'reviewed',patch:'',validation:'',files:[]}};return {session:structuredClone(s)};};
      window.dispatchEvent(new CustomEvent('gnosis-resolve-conflicts',{detail:window.conflictFixture.url}));
      return true;
    })()`);
    await c.step('wait .conflict-block[data-state=open]');
    // The first open per account shows a short guide to Merged, Check and Decide; the docs show the view itself.
    await c.js(`(()=>{const b=[...document.querySelectorAll('[data-conflict-guide] button')].find(b=>b.textContent.trim()==='Got it');if(b){b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));b.click()}return true})()`);
    await c.step('wait gone:[data-conflict-guide]');
  },

  /** The stack's merge plan and details (tests/stack-merge-details-browser.ts), with read-only mocks. */
  async stackMergePlan(c) {
    await queue(c);
    await c.js(`(async()=>{
      const stack=(await window.electronAPI.workbenchQueue()).items.find(i=>i.subject.kind==='stack');
      const read=window.electronAPI.getQueueSignals;
      window.electronAPI.getQueueSignals=async requests=>(await read(requests)).map(value=>{const n=Number(value.url.split('/').pop());return {...value,readiness:n===121?undefined:{...value.readiness,isDraft:n===122,mergeable:n===120?'CONFLICTING':'MERGEABLE',mergeState:n===120?'DIRTY':'CLEAN',reviewDecision:'APPROVED',behindBy:n===122?5:0}};});
      window.electronAPI.getPrActionState=async url=>{const m=stack.subject.members.find(m=>m.url===url);return {...m,account:'oddur',state:'OPEN',isDraft:true,canChangeDraft:true,canWrite:true,archived:false,methods:['SQUASH'],defaultMethod:'SQUASH',mergeable:'MERGEABLE',mergeState:'CLEAN',stack:null};};
      window.electronAPI.getPrActionStates=async(urls,force)=>Promise.all(urls.map(url=>window.electronAPI.getPrActionState(url,force).then(state=>({state}),error=>({error:error.message}))));
      window.electronAPI.performPrAction=async()=>({message:'Ready for review',status:'completed'});
      const {publishQueueSignals}=await import('/lib/use-queue-signals.ts');
      publishQueueSignals('oddur',await window.electronAPI.getQueueSignals(stack.subject.members.map(({url,headSha})=>({url,headSha}))));
      return true;
    })()`);
    await c.js(
      `document.querySelector('.queue-disclosure').closest('.queue-item').querySelector('.queue-row-main').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`
    );
    await c.until(`document.querySelectorAll('.stack-member-disclosure').length===3`, 'the three stack members');
    await c.step('scroll .stack-merge-plan');
  },

  /** In-diff breadcrumbs: the symbols a hunk sits in (tests/breadcrumb-nav-browser.ts, deep.ts). */
  async breadcrumbs(c) {
    await openPr(c);
    await prTab(c, 'Changes');
    await openFile(c, 'deep.ts', 'src/nav/deep.ts');
  },

  /** A moved function, noted where it landed (tests/moved-symbols-browser.ts). */
  async movedSymbols(c) {
    await openPr(c);
    await prTab(c, 'Changes');
    await openFile(c, 'queue.ts', 'src/moves/queue.ts');
  },

  /** Quiet changes: a hunk whose formatting-only lines are collapsed into a bar (tests/noise-filter-browser.ts). */
  async quietChanges(c) {
    await openPr(c);
    await prTab(c, 'Changes');
    await openFile(c, 'mixed.ts', 'src/noise/mixed.ts');
  },

  /** The Diff appearance popover with the quiet-changes toggles. */
  async diffAppearance(c) {
    await openPr(c);
    await prTab(c, 'Changes');
    await openFile(c, 'mixed.ts', 'src/noise/mixed.ts');
    await c.step('click text:Diff appearance');
  },

  /** A "Checks failed" notification with its first-time introduction (tests/notifications-browser.ts). */
  async notificationToast(c) {
    await queue(c);
    await c.js(
      `window.dispatchEvent(new CustomEvent('fixture-notification',{detail:{type:'show',delivery:{kind:'checks-failed',title:'Checks failed',body:'Introduce a bounded command queue',subtitle:'klang/engine #120',url:'https://github.com/klang/engine/pull/120',target:{kind:'pr',pr:{host:'github.com',owner:'klang',repo:'engine',number:120},tab:'checks'},keys:['checks-failed|docs'],types:['checks-failed'],introduce:true}}}))`
    );
  },

  /** The keyboard shortcut overlay. `?` is handled by the explanation reader (src/pages/ReviewPage.tsx). */
  async shortcutOverlay(c) {
    await openExplanation(c, 1);
    await c.js(`document.activeElement?.blur()`);
    await c.js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'?',shiftKey:true,bubbles:true}))`);
  },

  settingsQueue: settingsScene('Queue & briefings'),
  settingsRepositories: settingsScene('Repositories'),
  settingsReview: settingsScene('Review'),
  settingsAppearance: settingsScene('Appearance'),
  settingsNotifications: settingsScene('Notifications'),
  settingsIntegrations: settingsScene('Integrations'),
  settingsUpdates: settingsScene('Updates'),
  settingsDiagnostics: settingsScene('Diagnostics'),
};

export const sceneNames = Object.keys(scenes);
