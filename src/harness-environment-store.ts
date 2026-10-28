import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Provider } from '../lib/models';
import {
  emptyHarnessEnvironment,
  validateEnvironmentVariables,
  type HarnessEnvironment,
} from '../lib/harness-environment';
interface Encryption {
  available: () => boolean;
  encrypt: (text: string) => Uint8Array;
  decrypt: (data: Buffer) => string;
}
/** Async, atomic persistence. No plaintext fallback for values that can contain credentials. */
export function createHarnessEnvironmentStore(file: string, encryption: Encryption) {
  let cached: HarnessEnvironment | undefined;
  let loading: Promise<HarnessEnvironment> | undefined;
  let writing: Promise<unknown> = Promise.resolve();
  async function load(): Promise<HarnessEnvironment> {
    if (cached) return structuredClone(cached);
    if (!loading)
      loading = (async () => {
        try {
          const data = await fs.readFile(file);
          if (!encryption.available()) throw new Error();
          const parsed: unknown = JSON.parse(encryption.decrypt(data));
          if (!parsed || typeof parsed !== 'object' || !('claude' in parsed) || !('codex' in parsed)) throw Error();
          cached = {
            claude: validateEnvironmentVariables('claude', parsed.claude, process.platform === 'win32'),
            codex: validateEnvironmentVariables('codex', parsed.codex, process.platform === 'win32'),
          };
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
            cached = emptyHarnessEnvironment();
          else
            throw new Error('Could not unlock saved AI environment variables. Check your system keychain, then retry.');
        }
        return cached;
      })().finally(() => {
        loading = undefined;
      });
    return structuredClone(await loading);
  }
  function save(provider: Provider, variables: unknown): Promise<void> {
    const rows = validateEnvironmentVariables(provider, variables, process.platform === 'win32');
    const operation = writing.then(async () => {
      const current = await load();
      const next = { ...current, [provider]: rows };
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        if (!encryption.available())
          throw new Error('Secure storage is unavailable. Unlock your system keychain, then try saving again.');
        const encrypted = encryption.encrypt(JSON.stringify(next));
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, file);
        cached = next;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Secure storage is unavailable.')) throw error;
        throw new Error(
          'Could not save AI environment variables. Check your system keychain and available disk space, then retry.'
        );
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    });
    writing = operation.catch(() => {});
    return operation;
  }
  return { load, save };
}
