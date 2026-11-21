import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHAT_PANEL_DEFAULT_WIDTH,
  CHAT_PANEL_MAX_WIDTH,
  CHAT_PANEL_MIN_WIDTH,
  chatModelChoice,
  chatModelLabel,
  chatModelOptions,
  chatPanelWidth,
  clampChatPanelWidth,
  createChatPreferenceWriter,
  normalizeChatModels,
  normalizeChatPanelWidths,
} from '../lib/chat-preferences';
import { CLAUDE_MODELS, CODEX_MODELS } from '../lib/models';
import type { Preferences } from '../lib/types';

function memoryStore(initial: Partial<Preferences>) {
  let saved = { ...initial } as Preferences;
  const writes: Preferences[] = [];
  return {
    api: {
      loadPreferences: async () => structuredClone(saved),
      savePreferences: async (next: Preferences) => {
        saved = structuredClone(next);
        writes.push(saved);
      },
    },
    saved: () => saved,
    writes,
  };
}

void test('panel widths stay within the range and fall back to the default', () => {
  assert.equal(clampChatPanelWidth(10), CHAT_PANEL_MIN_WIDTH);
  assert.equal(clampChatPanelWidth(5000), CHAT_PANEL_MAX_WIDTH);
  assert.equal(clampChatPanelWidth(451.6), 452);
  assert.equal(clampChatPanelWidth(Number.NaN), CHAT_PANEL_DEFAULT_WIDTH);
  assert.deepEqual(normalizeChatPanelWidths({ topic: 512, file: 'wide', sidebar: 300, extra: null }), { topic: 512 });
  assert.deepEqual(normalizeChatPanelWidths({ file: 9999 }), { file: CHAT_PANEL_MAX_WIDTH });
  assert.deepEqual(normalizeChatPanelWidths('400'), {});
  assert.equal(chatPanelWidth(undefined, 'topic'), CHAT_PANEL_DEFAULT_WIDTH);
  assert.equal(chatPanelWidth({ chatPanelWidths: { file: 560 } }, 'file'), 560);
  assert.equal(chatPanelWidth({ chatPanelWidths: { file: 560 } }, 'topic'), CHAT_PANEL_DEFAULT_WIDTH);
});

void test('each surface keeps its own width, written into the latest saved preferences', async () => {
  const store = memoryStore({ theme: 'dark', chatPanelWidths: { topic: 480 } });
  const writer = createChatPreferenceWriter(() => store.api);
  await writer.width('file', 600);
  assert.deepEqual(store.saved().chatPanelWidths, { topic: 480, file: 600 });
  assert.equal(store.saved().theme, 'dark', 'Other preferences are kept');
  await writer.width('topic', undefined);
  assert.deepEqual(store.saved().chatPanelWidths, { file: 600 }, 'Reset forgets the surface width');
});

void test('the model selector lists every model the providers offer', () => {
  const options = chatModelOptions();
  assert.deepEqual(
    options.map((group) => group.label),
    ['Claude', 'Codex']
  );
  assert.deepEqual(
    options[0].models.map((m) => m.id),
    CLAUDE_MODELS.map((m) => m.id)
  );
  assert.deepEqual(
    options[1].models.map((m) => m.id),
    CODEX_MODELS.map((m) => m.id)
  );
  assert.equal(chatModelLabel({ provider: 'claude', model: 'claude-opus-5-5' }), 'Opus 5.5');
});

void test('a surface defaults to the chat model preference until it has its own choice', () => {
  const preferences = { provider: 'codex', model: 'gpt-6.2-astra' } as const;
  assert.deepEqual(chatModelChoice(preferences, 'topic'), { provider: 'codex', model: 'gpt-6.2-astra' });
  assert.deepEqual(
    chatModelChoice(
      { ...preferences, chatModels: { file: { provider: 'claude', model: 'claude-haiku-5-5' } } },
      'file'
    ),
    {
      provider: 'claude',
      model: 'claude-haiku-5-5',
    }
  );
  assert.deepEqual(chatModelChoice(undefined, 'topic'), { provider: 'claude', model: 'claude-opus-5-5' });
  // A retired model in the general preference moves to its successor, as everywhere else.
  assert.deepEqual(chatModelChoice({ provider: 'claude', model: 'claude-opus-5' as never }, 'file'), {
    provider: 'claude',
    model: 'claude-opus-5-5',
  });
});

void test('saved choices that no provider offers are dropped, never sent', () => {
  assert.deepEqual(
    normalizeChatModels({
      topic: { provider: 'claude', model: 'gpt-6.2-sol' },
      file: { provider: 'openai', model: 'gpt-6.2-sol' },
      other: { provider: 'claude', model: 'claude-opus-5-5' },
    }),
    {}
  );
  assert.deepEqual(
    chatModelChoice(
      {
        provider: 'claude',
        model: 'claude-sonnet-5-5',
        chatModels: { topic: { provider: 'claude', model: 'claude-opus-4-6' } } as never,
      },
      'topic'
    ),
    { provider: 'claude', model: 'claude-sonnet-5-5' },
    'A retired surface choice falls back to the general preference'
  );
});

void test('a model choice persists per surface and leaves the other surface alone', async () => {
  const store = memoryStore({ provider: 'claude', model: 'claude-opus-5-5' });
  const writer = createChatPreferenceWriter(() => store.api);
  await Promise.all([
    writer.model('topic', { provider: 'codex', model: 'gpt-6-luna' }),
    writer.model('file', { provider: 'claude', model: 'claude-haiku-5-5' }),
  ]);
  assert.deepEqual(store.saved().chatModels, {
    topic: { provider: 'codex', model: 'gpt-6-luna' },
    file: { provider: 'claude', model: 'claude-haiku-5-5' },
  });
  assert.equal(store.saved().model, 'claude-opus-5-5', 'The general model preference does not change');
  assert.deepEqual(chatModelChoice(store.saved(), 'topic'), { provider: 'codex', model: 'gpt-6-luna' });
  assert.equal(store.writes.length, 2, 'Writes run one after another, each on the latest preferences');
});

void test('a failed write does not stop the next', async () => {
  let fail = true;
  const store = memoryStore({});
  const writer = createChatPreferenceWriter(() => ({
    loadPreferences: store.api.loadPreferences,
    savePreferences: async (next: Preferences) => {
      if (fail) {
        fail = false;
        throw new Error('disk full');
      }
      await store.api.savePreferences(next);
    },
  }));
  await assert.rejects(writer.width('topic', 500));
  await writer.width('topic', 520);
  assert.deepEqual(store.saved().chatPanelWidths, { topic: 520 });
});
