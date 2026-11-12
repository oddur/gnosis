import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useFileChat } from '../lib/use-file-chat';
import type { FileChatRequest } from '../lib/pr-changes';
import { fileChatTrace, parseChatTrace, toolCallStep, type ChatTraceStep } from '../lib/chat-trace';

void test('file chat streams only its request, retains partial answers, retries and cancels without corrupting history', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://gnosis.test' });
  const originals = ['window', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT'].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
  );
  Object.defineProperties(globalThis, {
    window: { value: dom.window, configurable: true },
    localStorage: { value: dom.window.localStorage, configurable: true },
    IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
  });
  const callbacks = new Set<(event: { requestId: string; chunk: string }) => void>();
  const requests: FileChatRequest[] = [];
  let resolve!: (text: string) => void, reject!: (error: Error) => void;
  const cancelled: string[] = [];
  let writes = 0;
  const storageDescriptor = Object.getOwnPropertyDescriptor(dom.window.Storage.prototype, 'setItem');
  const originalSet = (target: Storage, key: string, value: string) =>
    Reflect.apply(storageDescriptor?.value as (key: string, value: string) => void, target, [key, value]);
  dom.window.Storage.prototype.setItem = function (...args) {
    writes++;
    originalSet(this, ...args);
  };
  Object.assign(dom.window, {
    electronAPI: {
      onFileChatProgress: (cb: (event: { requestId: string; chunk: string }) => void) => {
        callbacks.add(cb);
        return () => callbacks.delete(cb);
      },
      askPrFile: (request: FileChatRequest) => {
        requests.push(request);
        return new Promise<string>((yes, no) => {
          resolve = yes;
          reject = no;
        });
      },
      cancelChat: (id: string) => {
        cancelled.push(id);
        return Promise.resolve();
      },
    },
  });
  const container = dom.window.document.getElementById('root');
  assert.ok(container);
  const root = createRoot(container);
  let chat!: ReturnType<typeof useFileChat>;
  function Probe() {
    chat = useFileChat('file-chat-test');
    return null;
  }
  const request = {
    url: 'https://github.com/test/repo/pull/1',
    path: 'test.ts',
    baseSha: 'base',
    headSha: 'head',
    provider: 'codex' as const,
    model: 'gpt-6.1-sol' as const,
    question: 'Why?',
    selection: 'return value;',
  };
  const chunk = (requestId: string, text: string) => {
    for (const cb of callbacks) cb({ requestId, chunk: text });
  };
  const update = (fn: () => void) => act(() => Promise.resolve().then(fn));
  try {
    await act(() => Promise.resolve().then(() => root.render(createElement(Probe))));
    let pending!: Promise<boolean>;
    await update(() => {
      pending = chat.send(request);
    });
    const startWrites = writes;
    await update(() => {
      chunk('other', 'Wrong answer');
      chunk(requests[0].requestId ?? '', 'Partial answer');
    });
    assert.equal(chat.messages.at(-1)?.content, 'Partial answer');
    assert.equal(writes, startWrites, 'Streaming chunks must not write conversation storage');
    await act(async () => {
      reject(Error('Disconnected'));
      await pending;
    });
    assert.equal(chat.messages.at(-1)?.error, 'Disconnected');
    assert.equal(chat.messages.at(-1)?.content, 'Partial answer');
    await update(() => {
      pending = chat.retry(request, chat.messages.at(-1)?.id ?? '');
    });
    assert.equal(requests[1].history.length, 0);
    assert.equal(requests[1].selection, 'return value;');
    assert.equal(chat.messages.length, 2);
    await act(async () => {
      chunk(requests[1].requestId ?? '', 'Commentary');
      resolve('Authoritative final');
      await pending;
    });
    assert.equal(chat.messages.at(-1)?.content, 'Authoritative final');
    await update(() => {
      pending = chat.send({ ...request, question: 'Another question' });
    });
    assert.deepEqual(
      requests[2].history.map((m) => m.content),
      ['Regarding this code:\n```\nreturn value;\n```\n\nWhy?', 'Authoritative final']
    );
    await update(() => {
      chunk(requests[2].requestId ?? '', 'Keep this');
      chat.stop();
    });
    await act(async () => {
      chunk(requests[2].requestId ?? '', 'Do not append');
      resolve('Late answer');
      await pending;
    });
    assert.equal(cancelled[0], requests[2].requestId);
    assert.equal(chat.messages.at(-1)?.content, 'Keep this');
    assert.equal(chat.messages.at(-1)?.stopped, true);
    assert.equal(chat.busy, false);
    assert.equal(callbacks.size, 0);
    await update(() => {
      pending = chat.send({ ...request, question: 'After stop' });
    });
    assert.equal(requests[3].history.length, 2, 'Stopped pairs are not completed conversation history');
    await act(async () => {
      resolve('Done');
      await pending;
    });
  } finally {
    await act(() => Promise.resolve().then(() => root.unmount()));
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

void test('file chat keeps the live trace and saves it with the conversation', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://gnosis.test' });
  const originals = ['window', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT'].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
  );
  Object.defineProperties(globalThis, {
    window: { value: dom.window, configurable: true },
    localStorage: { value: dom.window.localStorage, configurable: true },
    IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
  });
  const traces = new Set<(event: { requestId?: string; steps: ChatTraceStep[] }) => void>();
  const requests: FileChatRequest[] = [];
  let resolve!: (text: string) => void;
  Object.assign(dom.window, {
    electronAPI: {
      onFileChatProgress: () => () => {},
      onChatTrace: (cb: (event: { requestId?: string; steps: ChatTraceStep[] }) => void) => {
        traces.add(cb);
        return () => traces.delete(cb);
      },
      askPrFile: (request: FileChatRequest) => {
        requests.push(request);
        return new Promise<string>((yes) => {
          resolve = yes;
        });
      },
      cancelChat: () => Promise.resolve(),
    },
  });
  // A conversation saved before traces existed still loads.
  localStorage.setItem(
    'gnosis-file-chat:v1:legacy',
    JSON.stringify([{ id: 'old', role: 'assistant', content: 'Old', trace: { steps: [{ id: 1 }] } }])
  );
  const container = dom.window.document.getElementById('root');
  assert.ok(container);
  const root = createRoot(container);
  let chat!: ReturnType<typeof useFileChat>;
  let legacy!: ReturnType<typeof useFileChat>;
  function Probe() {
    chat = useFileChat('file-chat-trace');
    legacy = useFileChat('legacy');
    return null;
  }
  const update = (fn: () => void) => act(() => Promise.resolve().then(fn));
  const emit = (requestId: string | undefined, steps: ChatTraceStep[]) => {
    for (const cb of traces) cb({ requestId, steps });
  };
  try {
    await update(() => root.render(createElement(Probe)));
    assert.equal(legacy.messages[0].trace, undefined, 'Malformed saved traces are dropped');
    let pending!: Promise<boolean>;
    await update(() => {
      pending = chat.send({
        url: 'https://github.com/test/repo/pull/1',
        path: 'src/queue.ts',
        baseSha: 'base',
        headSha: 'head',
        provider: 'claude',
        model: 'claude-opus-5-5',
        question: 'Why?',
        selection: '',
      });
    });
    const context = fileChatTrace({
      path: 'src/queue.ts',
      before: 'text',
      after: 'text',
      truncated: false,
      description: 'Body',
      historyCount: 0,
    }).steps;
    await update(() => {
      emit('someone-else', [toolCallStep({ id: 'x', name: 'Bash', input: { command: 'ls' } })]);
      emit(requests[0].requestId, context);
      emit(requests[0].requestId, [toolCallStep({ id: 'g', name: 'Grep', input: { pattern: 'dispatch' } })]);
    });
    assert.deepEqual(
      chat.messages.at(-1)?.trace?.steps.map((s) => s.kind),
      ['file', 'pr', 'search'],
      'Context and tool calls appear while the answer streams'
    );
    assert.equal(localStorage.getItem('gnosis-file-chat:v1:file-chat-trace')?.includes('"search"'), false);
    await act(async () => {
      resolve('Because.');
      await pending;
    });
    assert.equal(traces.size, 0, 'The trace listener is released');
    const saved = JSON.parse(localStorage.getItem('gnosis-file-chat:v1:file-chat-trace') ?? '[]') as Array<{
      trace?: unknown;
    }>;
    assert.deepEqual(
      parseChatTrace(saved.at(-1)?.trace)?.steps.map((s) => s.label),
      ['queue.ts', 'PR description', '“dispatch”']
    );
  } finally {
    await act(() => Promise.resolve().then(() => root.unmount()));
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
