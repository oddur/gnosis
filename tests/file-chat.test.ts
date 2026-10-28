import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useFileChat } from '../lib/use-file-chat';
import type { FileChatRequest } from '../lib/pr-changes';

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
      ['Why?', 'Authoritative final']
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
