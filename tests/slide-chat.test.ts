import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import { JSDOM } from 'jsdom';
import { useSlideChat } from '../lib/use-slide-chat';
import { createCodexEventHandler } from '../lib/providers/codex';
import type { ReviewGuide, SendSlideChatRequest } from '../lib/types';

const review: ReviewGuide = {
  prTitle: 'Fix addition',
  prDescription: '',
  prUrl: 'https://github.com/example/demo/pull/1',
  author: 'test',
  summary: '',
  riskLevel: 'low',
  riskRationale: '',
  totalFilesChanged: 1,
  totalLinesChanged: 2,
  slides: [
    {
      id: 'slide-1',
      slideNumber: 1,
      title: 'Correct addition',
      slideType: 'bugfix',
      narrative: '',
      reviewFocus: null,
      diffHunks: [],
      contextSnippets: [],
      affectedFiles: ['math.ts'],
      dependsOn: [],
    },
  ],
};

async function update(action: () => void) {
  await act(() => Promise.resolve().then(action));
}

for (const provider of ['codex', 'claude'] as const) {
  void test(`${provider} slide chat renders the final answer and uses it for follow-up history`, async (t) => {
    const dom = new JSDOM('<!doctype html><div id="root"></div>');
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalActFlag = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
    let onProgress: ((chunk: string) => void) | undefined;
    let finish: ((answer: string) => void) | undefined;
    const requests: SendSlideChatRequest[] = [];
    const electronAPI = {
      onChatProgress: (callback: (chunk: string) => void) => {
        onProgress = callback;
      },
      offChatProgress: () => {
        onProgress = undefined;
      },
      onChatToolUse: () => {},
      offChatToolUse: () => {},
      sendSlideChat: (request: SendSlideChatRequest) => {
        requests.push(request);
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
    } satisfies Partial<Window['electronAPI']>;
    Object.assign(dom.window, { electronAPI });
    const container = dom.window.document.getElementById('root');
    assert.ok(container);
    const root = createRoot(container);
    t.after(async () => {
      await update(() => {
        root.unmount();
      });
      dom.window.close();
      for (const [key, descriptor] of [
        ['window', originalWindow],
        ['IS_REACT_ACT_ENVIRONMENT', originalActFlag],
      ] as const) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    });
    let chat: ReturnType<typeof useSlideChat> | undefined;
    function Probe() {
      chat = useSlideChat(review, provider, provider === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5');
      return createElement(
        'div',
        {},
        chat
          .getMessages(1)
          .filter((message) => message.role === 'assistant')
          .map((message) => createElement(ReactMarkdown, { key: message.id }, message.content))
      );
    }
    function getChat() {
      assert.ok(chat);
      return chat;
    }
    await update(() => {
      root.render(createElement(Probe));
    });
    let pending = Promise.resolve();
    await update(() => {
      pending = getChat().send(1, 'Why was this a bug?');
    });
    const answer = '## Explanation\n\nThe function subtracted instead of adding.';
    await update(() => {
      assert.ok(onProgress);
      if (provider === 'codex') {
        const events = createCodexEventHandler((text, thinking) => {
          if (!thinking) onProgress?.(text);
        });
        for (const item of [
          { id: 'comment', type: 'agent_message', text: 'Preparing the answer' },
          { id: 'comment', type: 'agent_message', text: 'Preparing the answer' },
          { id: 'reason', type: 'reasoning', text: 'Reasoning is not chat history' },
          { id: 'answer', type: 'agent_message', text: answer },
        ])
          events.processLine(JSON.stringify({ type: 'item.completed', item }));
      } else {
        onProgress('## Expl');
        onProgress('anation\n\nThe function subtracted instead of adding.');
      }
    });
    assert.equal(container.querySelector('h2')?.textContent, 'Explanation', 'Markdown is intact while streaming');
    assert.equal(
      getChat().getMessages(1)[1].content,
      provider === 'codex' ? `Preparing the answer\n\n${answer}` : answer
    );
    await act(async () => {
      assert.ok(finish);
      finish(answer);
      await pending;
    });
    assert.equal(getChat().getMessages(1)[1].content, answer);
    assert.equal(getChat().getMessages(1)[1].isStreaming, false);
    assert.equal(container.textContent.includes('Preparing the answer'), false);
    assert.equal(container.querySelector('h2')?.textContent, 'Explanation');
    await update(() => {
      pending = getChat().send(1, 'What should I test?');
    });
    assert.deepEqual(requests[1].history, [
      { role: 'user', content: 'Why was this a bug?' },
      { role: 'assistant', content: answer },
    ]);
    // Providers may return a final answer without emitting progress events.
    await act(async () => {
      assert.ok(finish);
      finish('Test positive and negative operands.');
      await pending;
    });
    assert.equal(getChat().getMessages(1)[3].content, 'Test positive and negative operands.');
  });
}
