import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMarkdownReviewService } from '../src/markdown-review-service';
void test('the production-built backend worker queues comparisons, survives a rejected document and disposes cleanly', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-md-worker-'));
  const workerPath = path.join(directory, 'markdown-review-worker.cjs');
  await build({
    configFile: 'vite.markdown-worker.config.ts',
    logLevel: 'silent',
    build: {
      outDir: directory,
      lib: {
        entry: path.resolve('src/markdown-review-worker.ts'),
        formats: ['cjs'],
        fileName: () => 'markdown-review-worker.cjs',
      },
      minify: false,
    },
  });
  const service = createMarkdownReviewService(workerPath);
  const source = { repo: 'owner/repo', path: 'README.md', ref: 'revision' };
  const request = { before: 'Before.', after: 'After.', beforeSource: source, afterSource: source };
  try {
    const results = await Promise.all([service.render(request), service.render({ ...request, after: 'Another.' })]);
    assert.equal(results[0].blocks[0].change, 'changed');
    assert.notDeepEqual(results[0].clean, results[1].clean);
    assert.deepEqual(await service.render(request), results[0]);
    const code = await service.render({
      ...request,
      before: '```ts\nconst retries = 3;\n```',
      after: '```ts\nconst retries = 5;\n```',
    });
    assert.equal(code.blocks[0].change, 'changed');
    assert.match(JSON.stringify(code), /--shiki-light/);
    await assert.rejects(service.render(null), /revision is missing/);
    await assert.rejects(service.render({ ...request, after: 'x'.repeat(500_001) }), /too large/);
    assert.deepEqual(await service.render(request), results[0]);
  } finally {
    service.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
  await assert.rejects(service.render(request), /closing/);
});
