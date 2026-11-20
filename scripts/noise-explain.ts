/**
 * Shows why the quiet-change classifier (#396) calls a change code: each code block's lines on both sides.
 *
 *   npx tsx scripts/noise-explain.ts <before-file> <after-file> [language]
 */
import fs from 'node:fs';
import { structuredPatch } from 'diff';
import { kinds } from './noise-audit-core';
import { syntaxLanguage, type SyntaxLanguage } from '../lib/syntax-scope';

async function main() {
  const [beforeFile, afterFile, forced] = process.argv.slice(2);
  const language = (forced as SyntaxLanguage | undefined) ?? syntaxLanguage(afterFile) ?? syntaxLanguage(beforeFile);
  if (!language) throw Error('No grammar for this file');
  const before = fs.readFileSync(beforeFile, 'utf8'),
    after = fs.readFileSync(afterFile, 'utf8');
  const { blocks } = await kinds(language, before, after);
  const oldLines = before.split('\n'),
    newLines = after.split('\n');
  for (const block of blocks) {
    if (block.kind !== 'code') continue;
    console.log(`── code (${block.reason}) old ${block.oldStart}+${block.oldCount} new ${block.newStart}+${block.newCount}`);
    for (const line of oldLines.slice(block.oldStart - 1, block.oldStart - 1 + block.oldCount)) console.log(`-${line}`);
    for (const line of newLines.slice(block.newStart - 1, block.newStart - 1 + block.newCount)) console.log(`+${line}`);
  }
  const quiet = blocks.filter((b) => b.kind !== 'code').length;
  console.log(`${blocks.length} blocks, ${quiet} quiet`);
  void structuredPatch;
}
void main();
