import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  initialSetup,
  normalizeSetup,
  setupViews,
  setupPreferences,
  setupForInstalledProviders,
} from '../lib/onboarding';
import { applyViewAction, normalizeViews } from '../lib/saved-views';
import {
  normalizeQueueFilters,
  matchesQueueFilters,
  activeQueueFilterCount,
  describeQueueFilters,
} from '../lib/queue-filters';
import type { Preferences } from '../lib/types';
import type { QueueItem, ReviewMember } from '../lib/workbench';
const prefs = {
  watchedRepos: [],
  guestMode: false,
  prInactivityDays: 30,
  ignoreDependabotPrs: true,
  autoBriefings: false,
  provider: 'claude',
  model: 'claude-opus-5-5',
  instructions: 'keep',
  proactiveMode: false,
} as unknown as Preferences;
const member = (patch: Partial<ReviewMember> = {}) =>
  ({
    state: 'open',
    merged: false,
    author: 'someone',
    repo: 'org/one',
    requestedReviewers: [],
    assignees: [],
    labels: [],
    title: 'Change',
    number: 1,
    baseBranch: 'main',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...patch,
  }) as ReviewMember;
const item = (...members: ReviewMember[]) =>
  ({ subject: { title: 'Stack', kind: 'stack', members }, attention: 'updated' }) as QueueItem;

void test('installed harnesses select separate explanation and briefing defaults', () => {
  for (const [provider, explanation, briefing] of [
    ['claude', 'claude-opus-5-5', 'claude-sonnet-5-5'],
    ['codex', 'gpt-6.1-sol', 'gpt-6.1-terra'],
  ] as const) {
    const draft = setupForInstalledProviders(initialSetup(prefs), [provider]);
    assert.equal(draft.provider, provider);
    assert.equal(draft.model, explanation);
    assert.equal(draft.briefingProvider, provider);
    assert.equal(draft.briefingModel, briefing);
    const saved = setupPreferences(prefs, draft);
    assert.equal(saved.provider, provider);
    assert.equal(saved.model, explanation);
    assert.equal(saved.proactiveReviewOverrides, true);
    assert.equal(saved.proactiveProvider, provider);
    assert.equal(saved.proactiveModel, briefing);
    assert.equal(saved.autoBriefings, false, 'detecting tools does not opt into automation');
    assert.equal(saved.instructions, 'keep');
  }
});

void test('replaying and resuming setup preserve independent model choices', () => {
  const saved = {
    ...prefs,
    firstRunSeen: true,
    provider: 'codex' as const,
    model: 'gpt-6-astra' as const,
    proactiveReviewOverrides: true,
    proactiveProvider: 'claude' as const,
    proactiveModel: 'claude-haiku-5-5' as const,
  };
  const draft = setupForInstalledProviders(initialSetup(saved), ['claude', 'codex']);
  assert.equal(draft.model, 'gpt-6-astra');
  assert.equal(draft.briefingProvider, 'claude');
  assert.equal(draft.briefingModel, 'claude-haiku-5-5');
  assert.deepEqual(normalizeSetup(normalizeSetup(draft)), normalizeSetup(draft));
  const next = setupPreferences(saved, normalizeSetup(draft));
  assert.equal(next.model, saved.model);
  assert.equal(next.proactiveModel, saved.proactiveModel);
  const codexOnly = setupForInstalledProviders(draft, ['codex']);
  assert.equal(codexOnly.model, 'gpt-6-astra');
  assert.equal(codexOnly.briefingModel, 'gpt-6.1-terra');
  assert.equal(codexOnly.briefingProvider, 'codex');
  const skipped = setupPreferences(saved, { ...codexOnly, configureAI: false });
  assert.equal(skipped.proactiveModel, saved.proactiveModel);
});

void test('missing tools leave AI unconfigured and old setup drafts migrate safely', () => {
  const draft = initialSetup(prefs);
  assert.equal(setupForInstalledProviders(draft, []).configureAI, false);
  const legacy = { ...draft } as Record<string, unknown>;
  delete legacy.briefingProvider;
  delete legacy.briefingModel;
  assert.equal(normalizeSetup(legacy).briefingModel, 'claude-sonnet-5-5');
  const chosen = normalizeSetup({ ...legacy, configureAI: true, provider: 'codex', model: 'gpt-6-astra' });
  assert.equal(chosen.briefingProvider, 'codex');
  assert.equal(chosen.briefingModel, 'gpt-6-astra', 'keep an explicitly chosen model in older drafts');
});
void test('personal review presets are distinct and do not depend on AI attention status', () => {
  const setup = initialSetup(prefs);
  setup.goals = ['review', 'authored'];
  const [review, authored] = setupViews(setup);
  assert.equal(matchesQueueFilters(item(member({ author: 'ALICE' })), review.filters, Date.now(), 'alice'), false);
  assert.equal(matchesQueueFilters(item(member({ author: 'ALICE' })), authored.filters, Date.now(), 'alice'), true);
  assert.equal(matchesQueueFilters(item(member({ assignees: ['ALICE'] })), review.filters, Date.now(), 'alice'), true);
  assert.equal(
    matchesQueueFilters(item(member({ requestedReviewers: ['alice'] })), review.filters, Date.now(), 'alice'),
    true
  );
  assert.equal(
    matchesQueueFilters(item(member({ role: 'review-requested' })), review.filters, Date.now(), null),
    false
  );
});
void test('repository views match selected repositories while preserving same-member stack matching', () => {
  const setup = initialSetup(prefs);
  setup.goals = ['repositories'];
  setup.repositories = ['Org/One', 'org/two'];
  const filters = setupViews(setup)[0].filters;
  assert.equal(matchesQueueFilters(item(member({ repo: 'ORG/TWO' })), filters), true);
  assert.equal(matchesQueueFilters(item(member({ repo: 'org/three' })), filters), false);
  const combined = normalizeQueueFilters({ ...filters, involvement: 'authored' });
  assert.equal(
    matchesQueueFilters(
      item(member({ repo: 'org/one' }), member({ repo: 'org/three', author: 'alice' })),
      combined,
      Date.now(),
      'alice'
    ),
    false
  );
  assert.equal(activeQueueFilterCount(normalizeQueueFilters({ repos: ['org/one'] })), 1);
  assert.equal(
    describeQueueFilters(filters).some((f) => f.key === 'repos'),
    true
  );
});
void test('replaying setup updates owned views, preserves unrelated views and does not duplicate', () => {
  let state = normalizeViews(null);
  state = applyViewAction(state, { type: 'create', name: 'Needs my review' }, () => 'custom');
  const setup = initialSetup(prefs, state);
  assert.equal(setup.names.review, 'Needs my review 2');
  const action = { type: 'setup' as const, views: setupViews(setup), activeId: 'setup:review' };
  state = applyViewAction(state, action, () => 'unused');
  state = applyViewAction(state, action, () => 'unused');
  assert.equal(state.views.length, 2);
  assert.equal(state.views[0].id, 'custom');
  assert.equal(state.activeId, 'setup:review');
  assert.throws(
    () =>
      applyViewAction(state, { ...action, views: [{ ...action.views[0], name: 'Needs my review' }] }, () => 'unused'),
    /already has/
  );
  assert.equal(state.views[1].name, 'Needs my review 2');
});
void test('setup validates required repositories, keeps unrelated preferences and supports local mode', () => {
  const setup = initialSetup(prefs);
  setup.goals = ['repositories'];
  assert.throws(() => setupViews(setup), /Choose a repository/);
  setup.local = true;
  setup.autoBriefings = true;
  assert.deepEqual(setupViews(setup), []);
  const next = setupPreferences(prefs, setup);
  assert.equal(next.autoBriefings, false);
  assert.equal(next.instructions, 'keep');
  assert.equal(next.model, prefs.model, 'skipping AI setup preserves the current model');
  assert.equal(next.firstRunSeen, true);
  assert.equal(next.guestMode, true);
  assert.equal(normalizeSetup({ ...setup, dailyLimit: -100 }).dailyLimit, 1);
  assert.equal(
    initialSetup({ ...prefs, autoBriefings: true }).autoBriefings,
    true,
    'existing automation choice is preserved'
  );
});

void test('applying setup rolls back views and preferences on write failure and refuses account changes', async () => {
  const { createOnboardingService } = await import('../src/onboarding-service');
  let currentPrefs = structuredClone(prefs),
    views = normalizeViews(null),
    account: string | null = 'alice';
  const data = new Map<string, unknown>();
  let fail = true;
  const service = createOnboardingService({
    account: () => account,
    preferences: () => currentPrefs,
    views: () => views,
    savePreferences: (value) => {
      if (fail) {
        fail = false;
        throw Error('Disk full');
      }
      currentPrefs = value;
    },
    replaceViews: (value) => {
      views = value;
    },
    storage: {
      read: (key) => data.get(key),
      write: (key, value) => {
        data.set(key, value);
      },
      flush: () => Promise.resolve(),
    },
  });
  const draft = initialSetup(prefs);
  await service.save({ draft, paused: true, tourStep: 2 }, 'alice');
  await assert.rejects(service.apply(draft, 'alice'), /previous settings are kept/);
  assert.equal(views.views.length, 0);
  assert.equal(currentPrefs.firstRunSeen, undefined);
  assert.equal(service.load().paused, true);
  await service.apply(draft, 'alice');
  assert.equal(views.views.length, 1);
  assert.equal(currentPrefs.firstRunSeen, true);
  assert.equal(service.load().completed, true);
  account = 'bob';
  await assert.rejects(service.save({ draft }, 'alice'), /account changed/);
  await assert.rejects(service.apply(draft, 'alice'), /account changed/);
  assert.deepEqual(service.load(), {});
});

void test('setup drafts and walkthrough progress survive SQLite restart and cache clearing', async () => {
  const { createAppDataStore } = await import('../src/app-data-store');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-onboarding-'));
  let store = createAppDataStore();
  const state = { draft: initialSetup(prefs), paused: true, tourStep: 2 };
  try {
    await store.open(dir);
    store.write('onboarding:alice', state);
    await store.close();
    store = createAppDataStore();
    await store.open(dir);
    assert.deepEqual(store.read('onboarding:alice'), state);
    await store.clearGitHub();
    assert.deepEqual(store.read('onboarding:alice'), state);
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

void test('setup persists independent efforts and safely changes installed harnesses', () => {
  const draft = initialSetup({ ...prefs, firstRunSeen: true, provider: 'codex', model: 'gpt-6.1-sol',
    effort: 'ultra', proactiveEffort: 'medium', proactiveReviewOverrides: false });
  assert.equal(draft.effort, 'ultra');
  assert.equal(draft.briefingEffort, 'medium');
  const claudeOnly = setupForInstalledProviders(draft, ['claude']);
  assert.equal(claudeOnly.effort, 'max');
  assert.equal(claudeOnly.briefingEffort, 'medium');
  const saved = setupPreferences(prefs, claudeOnly);
  assert.equal(saved.effort, 'max');
  assert.equal(saved.proactiveEffort, 'medium');
  const legacy = initialSetup({ ...prefs, thinking: false, proactiveThinking: true });
  assert.equal(legacy.effort, 'low');
  assert.equal(legacy.briefingEffort, 'low');
  const invalid = normalizeSetup({ ...draft, effort: 'invalid', briefingEffort: 'invalid' });
  assert.equal(invalid.effort, 'high');
  assert.equal(invalid.briefingEffort, 'low');
});

void test('onboarding applies repository overrides and retains unwatched repository settings', () => {
  const draft = initialSetup({ ...prefs, repositorySettings: { 'org/old': { color: 'blue', autoBriefings: false } } });
  draft.repositories = ['org/new'];
  draft.repositorySettings = { ...draft.repositorySettings, 'ORG/New': { autoBriefings: true, prInactivityDays: 90, briefingDailyLimit: 3, icon: 'rocket' } };
  draft.repositoryDailyLimit = 8;
  const saved = setupPreferences(prefs, draft);
  assert.equal(saved.repositorySettings?.['org/new'].briefingDailyLimit, 3);
  assert.equal(saved.repositorySettings?.['org/old'].color, 'blue');
  assert.equal(saved.repositoryBriefingDailyLimit, 8);
  assert.deepEqual(normalizeSetup(draft).repositorySettings, saved.repositorySettings);
});
