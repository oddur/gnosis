/**
 * Synthetic fixtures for the explanation slices (lib/explanation-slices.ts, #561). The Rust one is shaped like
 * klanggames/seed#38134: a new file of about 1,000 lines (a struct, an impl of 20 methods and a tests module), and a
 * large deletion from another file whose methods partly reappear in the new one (two unchanged, one edited).
 */

/** A Rust method of about 30 lines whose identifiers carry `name`, so no two methods look alike. */
export function rustMethod(name: string, seed: number, edited = false): string[] {
  const id = (word: string) => `${word}_${name}`;
  return [
    `    /// Runs the ${name} step over the queue's entities.`,
    `    pub fn ${name}(&mut self, ${id('input')}: u64, ${id('limit')}: usize) -> u64 {`,
    `        let mut ${id('total')} = self.${id('count')}.wrapping_add(${id('input')});`,
    `        let ${id('seed')} = ${seed}u64.rotate_left(${seed % 13});`,
    `        for ${id('step')} in 0..${id('limit')} {`,
    `            ${id('total')} = ${id('total')}.rotate_left(${id('step')} as u32) ^ ${id('seed')};`,
    `            if ${id('total')} % ${edited ? 11 : 7} == 0 {`,
    `                self.${id('hits')} += 1;`,
    `                self.${id('history')}.push(${id('total')});`,
    `            } else if ${id('total')} % 5 == ${seed % 5} {`,
    `                self.${id('misses')} = self.${id('misses')}.saturating_add(${id('step')} as u64);`,
    `            }`,
    `        }`,
    `        let ${id('window')} = self.${id('history')}.len().min(${id('limit')});`,
    `        let ${id('tail')}: u64 = self.${id('history')}[self.${id('history')}.len() - ${id('window')}..].iter().sum();`,
    `        if ${id('tail')} > ${id('total')} {`,
    `            self.${id('state')} = State::Draining(${id('tail')} - ${id('total')});`,
    `        } else {`,
    `            self.${id('state')} = State::Idle;`,
    `        }`,
    `        match self.${id('mode')} {`,
    `            Mode::Fast => ${id('total')}.wrapping_mul(${edited ? 3 : 2}),`,
    `            Mode::Slow => ${id('total')} / ${seed + 2},`,
    `            Mode::Paused => {`,
    `                self.${id('paused')} += 1;`,
    `                ${id('total')}`,
    `            }`,
    `        }`,
    `    }`,
    ``,
  ];
}

/** A Rust test of about 12 lines. */
export function rustTest(name: string, seed: number): string[] {
  return [
    `    #[test]`,
    `    fn ${name}() {`,
    `        let mut state = EntityDrainState::default();`,
    `        let first_${name} = state.supersede(${seed}, ${(seed % 9) + 1});`,
    `        let second_${name} = state.drain_entities(first_${name}, ${(seed % 7) + 2});`,
    `        assert!(second_${name} >= ${seed % 3});`,
    `        assert_eq!(state.hits_${name}, 0);`,
    `        for round_${name} in 0..${(seed % 4) + 2} {`,
    `            state.requeue(round_${name}, 1);`,
    `        }`,
    `        assert!(state.history_supersede.len() <= ${seed + 40});`,
    `    }`,
    ``,
  ];
}

export const MOVED_IDENTICAL = ['supersede', 'drain_entities'];
export const MOVED_EDITED = 'requeue';
export const DELETED_ONLY = ['legacy_flush', 'legacy_compact'];
const DRAIN_METHODS = [
  'supersede',
  'drain_entities',
  'requeue',
  'claim_batch',
  'release_batch',
  'schedule_retry',
  'expire_leases',
  'record_failure',
  'record_success',
  'rebalance',
  'pause_partition',
  'resume_partition',
  'compact_history',
  'snapshot_counts',
  'restore_counts',
  'promote_waiting',
  'demote_running',
  'trim_backlog',
  'verify_invariants',
  'flush_metrics',
];
const SEEDS = new Map(
  [...DRAIN_METHODS, ...DELETED_ONLY, 'len_hint', 'new_queue'].map((name, index) => [name, 17 + index * 7])
);
const seed = (name: string) => SEEDS.get(name) ?? 1;

/** The new file: imports, a constant, a struct, an impl of 20 methods and a tests module. */
export function drainFile(): string {
  const lines = [
    'use std::collections::VecDeque;',
    'use crate::queue::{Mode, State};',
    '',
    'const MAX_BATCH: usize = 64;',
    '',
    '/// What the drain keeps for each entity.',
    '#[derive(Default)]',
    'pub struct EntityDrainState {',
    ...DRAIN_METHODS.flatMap((name) => [`    count_${name}: u64,`, `    hits_${name}: u64,`]),
    '    pending: VecDeque<u64>,',
    '}',
    '',
    'impl EntityDrainState {',
    ...DRAIN_METHODS.flatMap((name) => rustMethod(name, seed(name))),
    '}',
    '',
    '#[cfg(test)]',
    'mod tests {',
    '    use super::*;',
    '',
    ...Array.from({ length: 26 }, (_, i) => rustTest(`drains_case_${i}`, 3 + i * 5)).flat(),
    '}',
  ];
  return `${lines.join('\n')}\n`;
}

/** The old file before: an impl with the methods that move away, and the ones that are only deleted. */
function queueFile(withMoved: boolean): string {
  const moved = withMoved
    ? [...MOVED_IDENTICAL, MOVED_EDITED, ...DELETED_ONLY].flatMap((name) => rustMethod(name, seed(name), false))
    : [];
  const lines = [
    'use std::collections::VecDeque;',
    '',
    'pub enum Mode { Fast, Slow, Paused }',
    'pub enum State { Idle, Draining(u64) }',
    '',
    'pub struct Queue {',
    '    pending: VecDeque<u64>,',
    '}',
    '',
    'impl Queue {',
    ...rustMethod('new_queue', seed('new_queue')),
    ...moved,
    ...rustMethod('len_hint', seed('len_hint')),
    '}',
  ];
  return `${lines.join('\n')}\n`;
}
export const queueBefore = () => queueFile(true);
export const queueAfter = () => queueFile(false);

/** The edited copy's body, for the new file: `requeue` with two tokens changed. */
export function drainFileWithEditedRequeue(): string {
  const plain = rustMethod(MOVED_EDITED, seed(MOVED_EDITED)).join('\n');
  const edited = rustMethod(MOVED_EDITED, seed(MOVED_EDITED), true).join('\n');
  return drainFile().replace(plain, edited);
}

/** A TypeScript file of about 300 lines: imports, an interface, a class of 12 methods and two functions. */
export function storeFile(): string {
  const method = (name: string, n: number) => [
    `  /** Saves the ${name} part of the store. */`,
    `  ${name}(input: number[], limit: number): number {`,
    `    let total${n} = this.base${n};`,
    ...Array.from(
      { length: 14 },
      (_, i) => `    total${n} += input[${i}] * ${n}${i} - Math.min(limit, input.length + ${i});`
    ),
    `    this.history.push(total${n});`,
    `    return total${n};`,
    `  }`,
    ``,
  ];
  const names = [
    'save',
    'load',
    'flush',
    'merge',
    'split',
    'index',
    'prune',
    'compact',
    'restore',
    'verify',
    'export',
    'reset',
  ];
  const lines = [
    "import { readFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    '',
    'export interface StoreOptions {',
    '  root: string;',
    '  limit: number;',
    '}',
    '',
    'export class Store {',
    '  history: number[] = [];',
    ...names.map((_, n) => `  base${n} = ${n};`),
    '',
    ...names.flatMap((name, n) => method(name, n)),
    '}',
    '',
    'export async function openStore(options: StoreOptions): Promise<Store> {',
    "  const text = await readFile(path.join(options.root, 'store.json'), 'utf8');",
    '  const store = new Store();',
    '  store.history = JSON.parse(text) as number[];',
    '  return store;',
    '}',
    '',
    'export function storeSize(store: Store): number {',
    '  return store.history.length;',
    '}',
  ];
  return `${lines.join('\n')}\n`;
}
