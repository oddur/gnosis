import type { Provider } from '../models';
import { emptyHarnessEnvironment, type HarnessEnvironment } from '../harness-environment';

let loadEnvironment: () => Promise<HarnessEnvironment> = () => Promise.resolve(emptyHarnessEnvironment());
/** Configured by Electron, keeping storage and secrets out of request payloads and prompts. */
export function setHarnessEnvironmentLoader(load: () => Promise<HarnessEnvironment>) {
  loadEnvironment = load;
}
export async function harnessEnvironment(provider: Provider): Promise<NodeJS.ProcessEnv> {
  const saved = await loadEnvironment();
  const env = { ...process.env };
  if (provider === 'claude') {
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_EFFORT_LEVEL;
    delete env.MAX_THINKING_TOKENS;
  }
  for (const { name, value } of saved[provider]) {
    // Windows environment keys are case insensitive; avoid two versions of PATH, etc.
    if (process.platform === 'win32')
      for (const key of Object.keys(env)) {
        if (key.toUpperCase() === name.toUpperCase()) Reflect.deleteProperty(env, key);
      }
    Object.defineProperty(env, process.platform === 'win32' && name.toUpperCase() === 'PATH' ? 'PATH' : name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return env;
}
