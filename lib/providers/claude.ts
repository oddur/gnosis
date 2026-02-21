import os from 'os';
import type { LLMProvider } from '../provider';
import { resolveBinaryPath, spawnCliStreaming, spawnCliQuick } from './shared';

const INSTALL_HINT = 'Install it from claude.ai/code and authenticate with `claude auth`.';

function resolveClaudePath(): string {
  return resolveBinaryPath('claude', [`${os.homedir()}/.volta/bin/claude`]);
}

function makeClaudeEnv(thinking: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  if (!thinking) env.MAX_THINKING_TOKENS = '0';
  return env;
}

export const claudeProvider: LLMProvider = {
  name: 'claude',
  models: [
    { id: 'claude-opus-4-6', label: 'Opus 4.6' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', quick: true },
  ],

  async generate({ content, systemPrompt, model, thinking, onChunk, mcpConfigPath, allowedTools }) {
    const claudePath = resolveClaudePath();
    let fullText = '';

    let streamError = '';

    function processLine(line: string): void {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const outer = JSON.parse(trimmed) as Record<string, unknown>;
        if (outer.type === 'result') {
          if (outer.is_error === true && typeof outer.result === 'string') {
            streamError = outer.result;
          } else if (typeof outer.result === 'string') {
            fullText = outer.result;
          }
          return;
        }
        if (outer.type !== 'stream_event') return;
        const inner = outer.event as Record<string, unknown> | undefined;
        if (!inner || inner.type !== 'content_block_delta') return;
        const delta = inner.delta as Record<string, unknown> | undefined;
        if (!delta) return;
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          onChunk?.(delta.thinking, true);
        } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          fullText += delta.text;
          onChunk?.(delta.text, false);
        }
      } catch {
        // not a JSON event
      }
    }

    const toolArgs: string[] = [];
    if (mcpConfigPath) {
      toolArgs.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
      if (allowedTools && allowedTools.length > 0) {
        toolArgs.push('--allowedTools', allowedTools.join(','));
      }
    } else {
      toolArgs.push('--tools', '');
    }

    await spawnCliStreaming({
      binPath: claudePath,
      cliName: 'Claude',
      args: [
        '-p',
        '--model',
        model,
        '--system-prompt',
        systemPrompt,
        ...toolArgs,
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--no-session-persistence',
        ...(thinking ? ['--effort', 'high'] : []),
      ],
      stdinContent: content,
      processLine,
      env: makeClaudeEnv(thinking),
      installHint: INSTALL_HINT,
      handleExitError: (stderr: string) => {
        if (streamError) return new Error(streamError);
        if (stderr) return new Error(stderr.slice(0, 300));
        return undefined;
      },
    });

    return fullText.trim();
  },

  quick({ content, systemPrompt, model }) {
    const claudePath = resolveClaudePath();
    return spawnCliQuick({
      binPath: claudePath,
      cliName: 'Claude',
      args: [
        '-p',
        '--model',
        model,
        '--system-prompt',
        systemPrompt,
        '--tools',
        '',
        '--output-format',
        'text',
        '--no-session-persistence',
      ],
      stdinContent: content,
      env: makeClaudeEnv(false),
      installHint: INSTALL_HINT,
    });
  },
};
