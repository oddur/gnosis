import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildExplainerDocument } from '../lib/explainer-document';
import {
  buildExplainerPrompt,
  captureExplainerContext,
  normalizeExplainerIdea,
  parseExplainer,
} from '../lib/explainer';
import { createExplainerService } from '../src/explainer-service';
import { buildArchive, parseArchive } from '../lib/review-archive';
import { explainer, review, slide } from './fixtures/explainer';
import type { LLMProvider } from '../lib/provider';
import type { Preferences, ReviewGuide } from '../lib/types';

void test('explainer metadata is optional and source references must belong to this slide', () => {
  assert.equal(normalizeExplainerIdea(undefined), null);
  assert.equal(normalizeExplainerIdea({ title: '', description: 'x' }), null);
  assert.deepEqual(parseExplainer('```json\n' + JSON.stringify(explainer) + '\n```', slide), explainer);
  assert.throws(
    () =>
      parseExplainer(
        JSON.stringify({ ...explainer, sources: [{ filePath: 'invented.ts', explanation: 'Not supplied.' }] }),
        slide
      ),
    /Sources must/
  );
  assert.throws(() => parseExplainer(JSON.stringify({ ...explainer, assumptions: [] }), slide), /assumptions/);
  const context = captureExplainerContext(
    slide,
    { 'queue.ts': 'old', 'secret.ts': 'unrelated' },
    { 'queue.ts': 'new' }
  );
  assert.ok(context.includes('old') && context.includes('new') && !context.includes('unrelated'));
  const prompt = buildExplainerPrompt(review, { ...slide, explainerContext: context });
  assert.ok(prompt.includes('queue.shift()') && prompt.includes('BEFORE:'));
  const html = buildExplainerDocument({ ...explainer, javascript: '</script><script>alert(1)</script>' }, 'test-nonce');
  assert.ok(!html.includes('</script><script>alert'));
  assert.ok(html.includes("connect-src 'none'") && html.includes("form-action 'none'"));
});

void test('generation repairs invalid output, saves once, and reuses the saved artifact without a model call', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-test-explainer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'review-1.json');
  fs.writeFileSync(file, JSON.stringify({ ...review, slides: [{ ...slide, explainer: { version: 0 } }] }));
  let calls = 0,
    validations = 0;
  let cwd = '';
  const provider: LLMProvider = {
    name: 'codex',
    models: [],
    quick: () => Promise.resolve(''),
    generate: (options) => {
      calls++;
      assert.equal(options.isolated, true);
      assert.equal(options.thinking, true);
      assert.ok(options.cwd);
      cwd = options.cwd;
      if (calls === 1) return Promise.resolve('broken JSON');
      assert.ok(options.content.includes('failed validation'));
      return Promise.resolve(JSON.stringify(explainer));
    },
  };
  const service = createExplainerService({
    reviewsDir: () => dir,
    preferences: () => ({ provider: 'codex', model: 'gpt-6.1-sol' }) as Preferences,
    provider: () => provider,
    validate: () => {
      validations++;
      return Promise.resolve();
    },
  });
  const req = { reviewId: 'review-1', slideId: slide.id };
  const first = service.generate(req, 1);
  assert.equal(service.generate(req, 1), first, 'duplicate clicks share the same generation');
  assert.throws(() => service.generate(req, 2), /another window/);
  assert.deepEqual(await first, explainer);
  assert.equal(fs.existsSync(cwd), false);
  assert.deepEqual(await service.generate(req, 1), explainer);
  assert.equal(calls, 2);
  assert.equal(validations, 1);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as ReviewGuide;
  const archive = buildArchive({
    review: saved,
    history: {
      id: 'review-1',
      prTitle: review.prTitle,
      prUrl: review.prUrl,
      author: review.author,
      riskLevel: 'low',
      savedAt: new Date().toISOString(),
    },
  });
  assert.deepEqual(parseArchive(archive).review.slides[0].explainer, explainer);
  assert.throws(() => service.generate({ ...req, reviewId: '../outside' }, 1), /Invalid/);
});

void test('cancelled refinements preserve the saved version and cannot be cancelled by another window', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-test-explainer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'review-1.json');
  fs.writeFileSync(file, JSON.stringify({ ...review, slides: [{ ...slide, explainer }] }));
  const provider: LLMProvider = {
    name: 'codex',
    models: [],
    quick: () => Promise.resolve(''),
    generate: (options) =>
      new Promise((_, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('cancelled')));
      }),
  };
  const service = createExplainerService({
    reviewsDir: () => dir,
    preferences: () => ({}) as Preferences,
    provider: () => provider,
    validate: async () => {},
  });
  const req = { reviewId: 'review-1', slideId: slide.id, refinement: 'Use two items.' };
  const promise = service.generate(req, 1);
  service.cancel(req, 2);
  service.cancel(req, 1);
  await assert.rejects(promise, /cancelled/);
  assert.deepEqual((JSON.parse(fs.readFileSync(file, 'utf8')) as ReviewGuide).slides[0].explainer, explainer);
});

void test('a completed generation cannot overwrite a review that changed underneath it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-test-explainer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'review-1.json');
  fs.writeFileSync(file, JSON.stringify(review));
  const provider: LLMProvider = {
    name: 'codex',
    models: [],
    quick: () => Promise.resolve(''),
    generate: () => Promise.resolve(JSON.stringify(explainer)),
  };
  const service = createExplainerService({
    reviewsDir: () => dir,
    preferences: () => ({}) as Preferences,
    provider: () => provider,
    validate: () => {
      fs.writeFileSync(file, JSON.stringify({ ...review, headSha: 'different' }));
      return Promise.resolve();
    },
  });
  await assert.rejects(service.generate({ reviewId: 'review-1', slideId: slide.id }, 1), /review changed/);
  assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as ReviewGuide).slides[0].explainer, undefined);
});

void test('failed refinements leave the previous artifact intact', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-test-explainer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'review-1.json');
  const original = JSON.stringify({ ...review, slides: [{ ...slide, explainer }] });
  fs.writeFileSync(file, original);
  let calls = 0;
  const provider: LLMProvider = {
    name: 'codex',
    models: [],
    quick: () => Promise.resolve(''),
    generate: () => {
      calls++;
      return Promise.resolve('invalid JSON');
    },
  };
  const service = createExplainerService({
    reviewsDir: () => dir,
    preferences: () => ({}) as Preferences,
    provider: () => provider,
    validate: () => Promise.resolve(),
  });
  await assert.rejects(service.generate({ reviewId: 'review-1', slideId: slide.id, refinement: 'Add a failure.' }, 1));
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

void test('slow generation gets ten minutes and reports a timeout instead of provider cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-test-explainer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'review-1.json'), JSON.stringify(review));
  let signal: AbortSignal | undefined;
  const provider: LLMProvider = {
    name: 'codex',
    models: [],
    quick: () => Promise.resolve(''),
    generate: (options) =>
      new Promise((_, reject) => {
        signal = options.signal;
        signal?.addEventListener('abort', () => reject(new Error('GNOSIS_CANCELLED')));
      }),
  };
  const service = createExplainerService({
    reviewsDir: () => dir,
    preferences: () => ({}) as Preferences,
    provider: () => provider,
    validate: async () => {},
  });
  const req = { reviewId: 'review-1', slideId: slide.id };
  const pending = service.generate(req, 1);
  t.mock.timers.tick(180000);
  assert.equal(signal?.aborted, false, 'three minutes must not interrupt a slower model');
  const timedOut = assert.rejects(pending, /Explainer generation timed out/);
  t.mock.timers.tick(420000);
  await timedOut;
  assert.equal(fs.existsSync(path.join(dir, 'review-1.json')), true);
  assert.equal(
    (JSON.parse(fs.readFileSync(path.join(dir, 'review-1.json'), 'utf8')) as ReviewGuide).slides[0].explainer,
    undefined
  );

  const retry = service.generate(req, 1);
  assert.equal(signal.aborted, false, 'retry starts a fresh request');
  const cancelled = assert.rejects(retry, /Explainer generation cancelled/);
  service.cancel(req, 1);
  await cancelled;
});
