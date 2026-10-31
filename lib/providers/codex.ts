import { normalizeEffort } from '../effort';
import { harnessEnvironment } from './environment';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { CODEX_MODELS } from '../models';
import type { GenerateOptions, LLMProvider } from '../provider';
import { resolveBinaryPath, spawnCliStreaming } from './shared';

const INSTALL_HINT = 'Install with `npm install -g @openai/codex`, then sign in with `codex login`.';

/** Codex exec emits complete items, rather than Claude's text deltas. */
export function createCodexEventHandler(onChunk?: GenerateOptions['onChunk']) {
  let failure: string | undefined;
  let hasAgentMessage = false;
  const seen = new Set<string>();
  return {
    processLine: (line: string) => {
      let event: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object') return;
        event = parsed as Record<string, unknown>;
      } catch {
        return; // Ignore non-JSON diagnostics from CLI wrappers.
      }
      if (event.type === 'turn.failed') {
        const error = event.error as { message?: unknown } | undefined;
        failure = typeof error?.message === 'string' ? error.message : 'Codex generation failed.';
      }
      // Top-level error events can be transient retries; turn.failed is terminal.
      if (event.type !== 'item.completed' || !event.item || typeof event.item !== 'object') return;
      const item = event.item as Record<string, unknown>;
      if (typeof item.id === 'string') {
        if (seen.has(item.id)) return;
        seen.add(item.id);
      }
      if (typeof item.text !== 'string' || !item.text) return;
      if (item.type === 'agent_message') {
        // Each completed item is a whole message, not a text delta. Keep
        // Markdown blocks separate while the renderer shows progress.
        onChunk?.(`${hasAgentMessage ? '\n\n' : ''}${item.text}`, false);
        hasAgentMessage = true;
      }
      if (item.type === 'reasoning') onChunk?.(item.text, true);
    },
    getFailure: () => failure,
  };
}

async function generate(opts: GenerateOptions): Promise<string> {
  if (opts.signal?.aborted) throw new Error('GNOSIS_CANCELLED');
  // Keep review prompts out of the application directory and the target repo.
  // Each writer gets its own directory so parallel reviews cannot share output.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-codex-'));
  try {
    const instructionsPath = path.join(dir, 'instructions.md');
    const outputPath = path.join(dir, 'answer.txt');
    await fs.writeFile(instructionsPath, opts.systemPrompt, { mode: 0o600 });
    const imageArgs: string[] = [];
    for (const [index, image] of (opts.images ?? []).entries()) {
      const imagePath = path.join(dir, `frame-${index}.png`);
      await fs.writeFile(imagePath, Buffer.from(image.base64, 'base64'), { mode: 0o600 });
      imageArgs.push('--image', imagePath);
    }
    const events = createCodexEventHandler(opts.onChunk);
    await spawnCliStreaming({
      binPath: resolveBinaryPath('codex', [path.join(os.homedir(), '.volta/bin/codex')]),
      cliName: 'Codex',
      args: [
        'exec',
        ...imageArgs,
        '--json',
        '--ephemeral',
        '--skip-git-repo-check',
        '--ignore-user-config',
        '--ignore-rules',
        '--sandbox',
        'read-only',
        '--model',
        opts.model,
        '--color',
        'never',
        '--output-last-message',
        outputPath,
        '-c',
        `model_instructions_file=${JSON.stringify(instructionsPath)}`,
        '-c',
        `model_reasoning_effort="${normalizeEffort('codex', opts.model, opts.effort, opts.thinking)}"`,
        '-c',
        'approval_policy="never"',
        '-c',
        'web_search="disabled"',
        '-c',
        'project_doc_max_bytes=0',
        '--disable',
        'shell_tool',
        '--disable',
        'apps',
        '--disable',
        'plugins',
        '--disable',
        'hooks',
        '--disable',
        'multi_agent',
        '-',
      ],
      stdinContent: opts.content,
      cwd: dir,
      env: await harnessEnvironment('codex'),
      installHint: INSTALL_HINT,
      processLine: events.processLine,
      signal: opts.signal,
      debugLog: false,
      handleExitError: () => {
        const failure = events.getFailure();
        return failure ? new Error(failure) : undefined;
      },
    });
    const failure = events.getFailure();
    if (failure) throw new Error(failure);
    // The final-message file excludes commentary and reasoning, which must
    // never be concatenated into the JSON expected by the review pipeline.
    const result = await fs.readFile(outputPath, 'utf8').catch((err: unknown) => {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return '';
      throw err;
    });
    if (!result.trim()) throw new Error('Codex returned no final response. Check your Codex login and model access.');
    return result.trim();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export const codexProvider: LLMProvider = {
  name: 'codex',
  models: [...CODEX_MODELS],
  generate,
  quick: (opts) => generate({ ...opts, thinking: false }),
};
