#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
import { setInterval, setTimeout } from 'node:timers';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
const instructionArg = args.find((arg) => arg.startsWith('model_instructions_file='));
const instructions = fs.readFileSync(JSON.parse(instructionArg.split('=').slice(1).join('=')), 'utf8');
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
if (input.mode === 'fail') {
  emit({ type: 'turn.failed', error: { message: 'Your Codex session has expired. Run codex login.' } });
  process.exit(1);
}
if (input.mode === 'zero-exit-failure') {
  emit({ type: 'turn.failed', error: { message: 'Model unavailable' } });
} else if (input.mode === 'empty') {
  emit({ type: 'turn.completed' });
} else if (input.mode === 'wait') {
  emit({ type: 'item.completed', item: { id: 'wait', type: 'agent_message', text: 'started' } });
  setInterval(() => {}, 1000);
} else {
  emit({ type: 'item.completed', item: { id: 'thinking', type: 'reasoning', text: 'Considering changes' } });
  const commentary = {
    type: 'item.completed',
    item: { id: 'commentary', type: 'agent_message', text: 'Preparing the answer' },
  };
  emit(commentary);
  emit(commentary);
  const answer = JSON.stringify({ args, cwd: process.cwd(), instructions, input });
  fs.writeFileSync(output, answer);
  // Emit the last event across chunks, without a trailing newline.
  const event = JSON.stringify({ type: 'item.completed', item: { id: 'final', type: 'agent_message', text: answer } });
  process.stdout.write(event.slice(0, 20));
  setTimeout(() => process.stdout.write(event.slice(20)), 10);
}
