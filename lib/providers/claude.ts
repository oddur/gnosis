import { normalizeEffort } from '../effort';
import { harnessEnvironment } from './environment';
import os from 'os';
import { CLAUDE_MODELS } from '../models';
import type { LLMProvider } from '../provider';
import { createClaudeEventHandler } from './claude-events';

export { createClaudeEventHandler };
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
    onToolCall,
    mcpConfigPath,
    allowedTools,
    cwd,
    nonStrictMcp,
    signal,
    isolated,
    images,
  }) {
    const claudePath = resolveClaudePath();
    const events = createClaudeEventHandler({ onChunk, onToolUse, onToolCall });
    const processLine = (line: string) => events.processLine(line);

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
        const streamError = events.getError();
        if (streamError && stderrTrimmed && !stderrTrimmed.includes(streamError)) {
          return new Error(`${streamError} — ${stderrTrimmed.slice(0, 200)}`);
        }
        if (streamError) return new Error(streamError);
        if (stderrTrimmed) return new Error(stderrTrimmed.slice(0, 300));
        return undefined;
      },
    });

    return events.getText().trim();
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
