#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const result = JSON.stringify({
  args,
  input: fs.readFileSync(0, 'utf8'),
  effortOverride: process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null,
  thinkingBudget: process.env.MAX_THINKING_TOKENS ?? null,
});
if (args[args.indexOf('--output-format') + 1] === 'stream-json') {
  process.stdout.write(JSON.stringify({ type: 'result', result, is_error: false }) + '\n');
} else {
  process.stdout.write(result);
}
