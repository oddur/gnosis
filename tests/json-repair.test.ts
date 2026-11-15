import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject, jsonErrorExcerpt, parseModelJson, repairJson } from '../lib/json-repair';
import { generateSlide } from '../lib/agent';
import { getProvider, type GenerateOptions } from '../lib/provider';
import { DEFAULT_CODEX_MODEL } from '../lib/models';

// Shaped like the writer output that failed with "Expected ':' after property name":
// a Dockerfile exec-form command where only the first quote was escaped.
const partlyEscapedCode =
  '{"title":"Boot checks for the published Rust and Node images","narrative":"The image runs a boot check.","inlineExplanations":[{"filePath":"images/node/Dockerfile","line":12,"side":"RIGHT","code":"CMD [\\"node", "--version"]","text":"Fails the build when Node is missing."}],"reviewChecks":[]}';

void test('the real failure shape is rejected by JSON.parse with the logged error', () => {
  assert.throws(() => JSON.parse(partlyEscapedCode), /Expected ':' after property name/);
});

void test('unescaped quotes inside strings are escaped, not treated as structure', () => {
  const parsed = parseModelJson(partlyEscapedCode) as { inlineExplanations: { code: string; text: string }[]; reviewChecks: unknown[] };
  assert.equal(parsed.inlineExplanations[0].code, 'CMD ["node", "--version"]');
  assert.equal(parsed.inlineExplanations[0].text, 'Fails the build when Node is missing.');
  assert.deepEqual(parsed.reviewChecks, []);
  const quoted = parseModelJson('{"narrative": "It prints "ok" and exits", "reviewFocus": null}') as { narrative: string };
  assert.equal(quoted.narrative, 'It prints "ok" and exits');
  const inArray = parseModelJson('{"contextSnippets": ["run "cargo test" first", "then lint"]}') as { contextSnippets: string[] };
  assert.deepEqual(inArray.contextSnippets, ['run "cargo test" first', 'then lint']);
});

void test('fences, prose, raw newlines, invalid escapes, comments and trailing commas are repaired', () => {
  assert.deepEqual(parseModelJson('Here is the slide:\n```json\n{"a": "line 1\nline 2\tend", "b": [1, 2,],}\n```\nDone.'), {
    a: 'line 1\nline 2\tend',
    b: [1, 2],
  });
  assert.deepEqual(parseModelJson('{"cmd": "echo \\$HOME", // the shell\n "n": 2 /* two */}'), { cmd: 'echo \\$HOME', n: 2 });
});

void test('truncated output keeps the complete fields', () => {
  const parsed = parseModelJson('{"title":"t","narrative":"Complete.","inlineExplanations":[{"filePath":"a.ts","line":3,"te') as {
    narrative: string;
    inlineExplanations: unknown[];
  };
  assert.equal(parsed.narrative, 'Complete.');
  assert.equal(Array.isArray(parsed.inlineExplanations), true);
  assert.deepEqual(JSON.parse(repairJson('{"a": "unfinished')), { a: 'unfinished' });
  assert.deepEqual(JSON.parse(repairJson('{"a": 1, "b"')), { a: 1 });
  assert.deepEqual(JSON.parse(repairJson('{"a": 1, "b":')), { a: 1, b: null });
});

void test('valid JSON is unchanged and hopeless text keeps the strict error', () => {
  const valid = '{"a":"x \\"y\\"","b":[{"c":null}]}';
  assert.deepEqual(parseModelJson(`prefix ${valid} suffix`), JSON.parse(valid));
  assert.equal(extractJsonObject(`noise {"a":{"b":"}"}} trailing }`), '{"a":{"b":"}"}}');
  assert.throws(() => parseModelJson('no json here'), SyntaxError);
});

void test('the writer repairs broken JSON without a second model call', async (t) => {
  const generate = t.mock.method(getProvider('codex'), 'generate', () => Promise.resolve(partlyEscapedCode));
  const slide = await generateSlide({ providerName: 'codex', model: DEFAULT_CODEX_MODEL, topicContext: 'Selected patch' });
  assert.equal(slide.title, 'Boot checks for the published Rust and Node images');
  assert.equal(slide.inlineExplanations?.[0].code, 'CMD ["node", "--version"]');
  assert.equal(generate.mock.calls.length, 1);
});

void test('an unrepairable writer response is retried with the parse error', async (t) => {
  const responses = ['{"title": "x", "narrative": undefined}', '{"title": "Fixed", "narrative": "Valid now."}'];
  const generate = t.mock.method(getProvider('codex'), 'generate', (options: GenerateOptions) => {
    if (generate.mock.calls.length === 1) {
      assert.match(options.content, /Your previous response was not valid JSON \(Unexpected token/);
      assert.match(options.content, /escape double quotes/);
    }
    return Promise.resolve(responses.shift() ?? '');
  });
  const slide = await generateSlide({ providerName: 'codex', model: DEFAULT_CODEX_MODEL, topicContext: 'Selected patch' });
  assert.equal(slide.narrative, 'Valid now.');
  assert.equal(generate.mock.calls.length, 2);
});

void test('log excerpts show the text around the parse error', () => {
  try {
    JSON.parse(partlyEscapedCode);
  } catch (error) {
    const excerpt = jsonErrorExcerpt(partlyEscapedCode, error, 20);
    assert.ok(excerpt?.includes('--version'));
  }
});
