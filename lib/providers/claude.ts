import { normalizeEffort } from '../effort';
import { harnessEnvironment } from './environment';
import os from 'os';
import { CLAUDE_MODELS } from '../models';
import type { LLMProvider } from '../provider';
import { resolveBinaryPath, spawnCliStreaming, spawnCliQuick } from './shared';

const INSTALL_HINT = 'Install it from claude.ai/code and authenticate with `claude auth`.';

function resolveClaudePath(): string {
  return resolveBinaryPath('claude', [`${os.homedir()}/.volta/bin/claude`]);
}

export const claudeProvider: LLMProvider = {
  name: 'claude',
  models: [...CLAUDE_MODELS],

  async generate({
    content,
    systemPrompt,
    model,
    thinking,
    effort,
    onChunk,
    onToolUse,
    mcpConfigPath,
    allowedTools,
    cwd,
    nonStrictMcp,
    signal,
    isolated,
    images,
  }) {
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
        if (!inner) return;
        if (inner.type === 'content_block_start') {
          const block = inner.content_block as Record<string, unknown> | undefined;
          if (block?.type === 'tool_use' && typeof block.name === 'string') {
            onToolUse?.(block.name);
          }
          return;
        }
        if (inner.type !== 'content_block_delta') return;
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
    if (isolated) {
      toolArgs.push('--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '');
    } else if (mcpConfigPath) {
      toolArgs.push('--mcp-config', mcpConfigPath);
      if (!nonStrictMcp) toolArgs.push('--strict-mcp-config');
    }
    if (!isolated && allowedTools && allowedTools.length > 0) {
      toolArgs.push('--allowedTools', allowedTools.join(','));
    } else if (!isolated && !mcpConfigPath && !nonStrictMcp) {
      // No explicit tool set AND no project-local MCP discovery → lock tools off.
      toolArgs.push('--tools', '');
    }

    await spawnCliStreaming({
      binPath: claudePath,
      cliName: 'Claude',
      cwd,
      args: [
        '-p',
        '--model',
        model,
        '--system-prompt',
        systemPrompt,
        ...toolArgs,
        ...(images?.length ? ['--input-format', 'stream-json'] : []),
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--no-session-persistence',
        '--effort',
        normalizeEffort('claude', model, effort, thinking),
      ],
      stdinContent: images?.length
        ? JSON.stringify({
            type: 'user',
            message: {
              role: 'user',
              content: [
                { type: 'text', text: content },
                ...images.map((image) => ({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: image.mediaType,
                    data: image.base64,
                  },
                })),
              ],
            },
          }) + '\n'
        : content,
      processLine,
      env: await harnessEnvironment('claude'),
      installHint: INSTALL_HINT,
      signal,
      handleExitError: (stderr: string) => {
        const stderrTrimmed = stderr.trim();
        if (streamError && stderrTrimmed && !stderrTrimmed.includes(streamError)) {
          return new Error(`${streamError} — ${stderrTrimmed.slice(0, 200)}`);
        }
        if (streamError) return new Error(streamError);
        if (stderrTrimmed) return new Error(stderrTrimmed.slice(0, 300));
        return undefined;
      },
    });

    return fullText.trim();
  },

  async quick({ content, systemPrompt, model, cwd }) {
    const claudePath = resolveClaudePath();
    return spawnCliQuick({
      binPath: claudePath,
      cliName: 'Claude',
      cwd,
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
        '--effort',
        'low',
      ],
      stdinContent: content,
      env: await harnessEnvironment('claude'),
      installHint: INSTALL_HINT,
    });
  },
};
