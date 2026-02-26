import type { LLMProvider } from '../provider';
import { resolveBinaryPath, spawnCliStreaming, spawnCliQuick } from './shared';

const INSTALL_HINT = 'Install it from https://github.com/google-gemini/gemini-cli and authenticate.';
const STDIN_PROMPT = 'Respond according to the instructions provided via stdin.';

function resolveGeminiPath(): string {
  return resolveBinaryPath('gemini');
}

function handleGeminiExitError(stderr: string): Error | undefined {
  const msg = stderr.slice(0, 300);
  if (msg.includes('ModelNotFoundError') || msg.includes('not found')) {
    return new Error('Model is not available on your account. Try a different model.');
  }
  return undefined;
}

export const geminiProvider: LLMProvider = {
  name: 'gemini',
  models: [
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
    { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro' },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', quick: true },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],

  async generate({ content, systemPrompt, model, onChunk, signal }) {
    const geminiPath = resolveGeminiPath();
    let fullText = '';

    function processLine(line: string): void {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        if (obj.type === 'message' && obj.role === 'assistant' && obj.delta === true) {
          const chunk = obj.content;
          if (typeof chunk === 'string') {
            fullText += chunk;
            onChunk?.(chunk, false);
          }
        }
      } catch {
        // not a JSON event
      }
    }

    await spawnCliStreaming({
      binPath: geminiPath,
      cliName: 'Gemini',
      args: ['-p', STDIN_PROMPT, '-m', model, '--output-format', 'stream-json', '--sandbox'],
      stdinContent: systemPrompt + '\n\n' + content,
      processLine,
      installHint: INSTALL_HINT,
      handleExitError: handleGeminiExitError,
      signal,
    });

    return fullText.trim();
  },

  quick({ content, systemPrompt, model }) {
    const geminiPath = resolveGeminiPath();
    return spawnCliQuick({
      binPath: geminiPath,
      cliName: 'Gemini',
      args: ['-p', STDIN_PROMPT, '-m', model, '--output-format', 'text', '--sandbox'],
      stdinContent: systemPrompt + '\n\n' + content,
      installHint: INSTALL_HINT,
      handleExitError: handleGeminiExitError,
    });
  },
};
