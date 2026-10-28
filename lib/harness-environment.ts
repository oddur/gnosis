import type { Provider } from './models';
export interface EnvironmentVariable {
  name: string;
  value: string;
}
export type HarnessEnvironment = Record<Provider, EnvironmentVariable[]>;
export const emptyHarnessEnvironment = (): HarnessEnvironment => ({ claude: [], codex: [] });
const managedClaudeVariables = new Set(['CLAUDECODE', 'CLAUDE_CODE_EFFORT_LEVEL', 'MAX_THINKING_TOKENS']);

/** Shared validation; never include variable values in errors. */
export function validateEnvironmentVariables(
  provider: unknown,
  input: unknown,
  windows = false
): EnvironmentVariable[] {
  if (provider !== 'claude' && provider !== 'codex') throw new Error('Choose Claude or Codex.');
  if (!Array.isArray(input) || input.length > 100) throw new Error('Use at most 100 environment variables per tool.');
  const names = new Set<string>();
  let size = 0;
  return input.map((row: unknown, index) => {
    if (
      !row ||
      typeof row !== 'object' ||
      !('name' in row) ||
      !('value' in row) ||
      typeof row.name !== 'string' ||
      typeof row.value !== 'string'
    )
      throw new Error(`Enter a name and value for variable ${index + 1}.`);
    const name = row.name.trim(),
      value = row.value;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error(`Variable ${index + 1}: use letters, numbers, and underscores; do not start with a number.`);
    const key = windows ? name.toUpperCase() : name;
    if (names.has(key)) throw new Error(`Variable ${index + 1}: this name is already in use.`);
    names.add(key);
    if (provider === 'claude' && managedClaudeVariables.has(name.toUpperCase()))
      throw new Error(`${name} is managed by Gnosis. Use the model and thinking settings instead.`);
    if (value.includes('\0')) throw new Error(`Variable ${index + 1}: the value cannot contain a null character.`);
    size += new TextEncoder().encode(name + value).byteLength;
    if (name.length > 256 || size > 64 * 1024)
      throw new Error('Environment variables are too large. Use shorter names or values.');
    return { name, value };
  });
}
