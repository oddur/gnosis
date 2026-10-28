import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { emptyHarnessEnvironment, validateEnvironmentVariables } from '../lib/harness-environment';
import { createHarnessEnvironmentStore } from '../src/harness-environment-store';
import { setHarnessEnvironmentLoader } from '../lib/providers/environment';
import { setBinaryOverride } from '../lib/providers/shared';
import { claudeProvider } from '../lib/providers/claude';
import { codexProvider } from '../lib/providers/codex';
interface Invocation {
  args: string[];
  testEnvironment: {
    override: string | null;
    inherited: string | null;
    onlyClaude: string | null;
    onlyCodex: string | null;
  };
}

void test('validates names and literal values without exposing secret values in errors', () => {
  const literal = '$HOME $(echo hello) `secret`\nsecond line';
  assert.deepEqual(
    validateEnvironmentVariables('codex', [
      { name: ' API_KEY ', value: literal },
      { name: 'EMPTY', value: '' },
    ]),
    [
      { name: 'API_KEY', value: literal },
      { name: 'EMPTY', value: '' },
    ]
  );
  for (const name of ['', '1BAD', 'BAD-KEY', 'A=B'])
    assert.throws(() => validateEnvironmentVariables('codex', [{ name, value: 'secret' }]), /Variable 1/);
  assert.throws(
    () =>
      validateEnvironmentVariables('codex', [
        { name: 'A', value: '' },
        { name: 'A', value: '' },
      ]),
    /already/
  );
  assert.throws(
    () =>
      validateEnvironmentVariables(
        'codex',
        [
          { name: 'Path', value: '' },
          { name: 'PATH', value: '' },
        ],
        true
      ),
    /already/
  );
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_EFFORT_LEVEL', 'MAX_THINKING_TOKENS'])
    assert.throws(() => validateEnvironmentVariables('claude', [{ name, value: 'secret' }]), /managed by Gnosis/);
  assert.throws(() => validateEnvironmentVariables('codex', [{ name: 'A', value: 'secret\0' }]), /null character/);
  assert.throws(() => validateEnvironmentVariables('codex', [{ name: 'A', value: 'é'.repeat(40000) }]), /too large/);
});

void test('encrypted persistence is atomic, private, retryable, and preserves concurrent provider edits', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-env-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'environment.enc');
  const key = randomBytes(32);
  let available = true;
  let failEncryption = false;
  const encryption = {
    available: () => available,
    encrypt: (value: string) => {
      if (failEncryption) throw Error('sensitive diagnostic');
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decrypt: (data: Buffer) => {
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
  const store = createHarnessEnvironmentStore(file, encryption);
  assert.deepEqual(await store.load(), emptyHarnessEnvironment());
  const claude = [{ name: 'TOKEN', value: 'claude-secret' }],
    codex = [{ name: 'TOKEN', value: 'codex-secret' }];
  await Promise.all([store.save('claude', claude), store.save('codex', codex)]);
  const expected = { claude, codex };
  const bytes = await fs.readFile(file);
  assert.equal(bytes.includes(Buffer.from('secret')), false);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await createHarnessEnvironmentStore(file, encryption).load(), expected);
  const copy = await store.load();
  copy.claude[0].value = 'mutation';
  assert.deepEqual(await store.load(), expected);
  failEncryption = true;
  await assert.rejects(store.save('claude', []), /Could not save/);
  assert.deepEqual(await store.load(), expected);
  assert.deepEqual(await fs.readFile(file), bytes);
  failEncryption = false;
  available = false;
  await assert.rejects(store.save('claude', []), /Secure storage is unavailable/);
  const locked = createHarnessEnvironmentStore(file, encryption);
  await assert.rejects(locked.load(), /Could not unlock/);
  available = true;
  assert.deepEqual(await locked.load(), expected);
  await fs.writeFile(file, 'corrupt');
  const corrupt = createHarnessEnvironmentStore(file, encryption);
  await assert.rejects(corrupt.load(), /Could not unlock/);
  await assert.rejects(corrupt.save('codex', []), /Could not unlock/);
  await fs.writeFile(file, bytes);
  assert.deepEqual(await corrupt.load(), expected);
  await store.save('claude', []);
  assert.deepEqual(await createHarnessEnvironmentStore(file, encryption).load(), { claude: [], codex });
  assert.deepEqual(await fs.readdir(dir), ['environment.enc']);
});

void test('both real CLI launch paths inherit, isolate and remove provider overrides without changing process.env', async (t) => {
  const keys = ['GNOSIS_TEST_OVERRIDE', 'GNOSIS_TEST_INHERITED', 'GNOSIS_TEST_CLAUDE', 'GNOSIS_TEST_CODEX'];
  const original = keys.map((key) => process.env[key]);
  t.after(() => {
    keys.forEach((key, i) => {
      if (original[i] === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = original[i];
    });
    setHarnessEnvironmentLoader(() => Promise.resolve(emptyHarnessEnvironment()));
    setBinaryOverride('claude', '');
    setBinaryOverride('codex', '');
  });
  process.env.GNOSIS_TEST_OVERRIDE = 'inherited';
  process.env.GNOSIS_TEST_INHERITED = 'shared';
  delete process.env.GNOSIS_TEST_CLAUDE;
  delete process.env.GNOSIS_TEST_CODEX;
  let settings = {
    claude: [
      { name: 'GNOSIS_TEST_OVERRIDE', value: '$HOME $(no-shell)' },
      { name: 'GNOSIS_TEST_CLAUDE', value: '' },
    ],
    codex: [
      { name: 'GNOSIS_TEST_OVERRIDE', value: 'codex' },
      { name: 'GNOSIS_TEST_CODEX', value: 'private' },
    ],
  };
  setHarnessEnvironmentLoader(() => Promise.resolve(settings));
  setBinaryOverride('claude', path.resolve('tests/fixtures/claude.mjs'));
  setBinaryOverride('codex', path.resolve('tests/fixtures/codex.mjs'));
  for (const provider of [claudeProvider, codexProvider]) {
    for (const launch of [provider.generate.bind(provider), provider.quick.bind(provider)]) {
      const result = JSON.parse(
        await launch({
          model: provider.name === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol',
          thinking: false,
          systemPrompt: 'Test',
          content: '{}',
        })
      ) as Invocation;
      assert.deepEqual(result.testEnvironment, {
        override: provider.name === 'claude' ? '$HOME $(no-shell)' : 'codex',
        inherited: 'shared',
        onlyClaude: provider.name === 'claude' ? '' : null,
        onlyCodex: provider.name === 'codex' ? 'private' : null,
      });
      assert.equal(
        result.args.some((arg: string) => arg.includes('GNOSIS_TEST_')),
        false
      );
    }
  }
  assert.equal(process.env.GNOSIS_TEST_OVERRIDE, 'inherited');
  settings = emptyHarnessEnvironment();
  const result = JSON.parse(
    await claudeProvider.quick({ model: 'claude-opus-5-5', systemPrompt: 'Test', content: '{}' })
  ) as Invocation;
  assert.equal(result.testEnvironment.override, 'inherited');
});
