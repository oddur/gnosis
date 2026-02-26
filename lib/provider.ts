import { claudeProvider } from './providers/claude';
import { geminiProvider } from './providers/gemini';
import type { ModelId, Provider } from './types';

export interface GenerateOptions {
  content: string;
  systemPrompt: string;
  model: ModelId;
  thinking: boolean;
  onChunk?: (chunk: string, isThinking: boolean) => void;
  onToolUse?: (toolName: string) => void;
  mcpConfigPath?: string;
  allowedTools?: string[];
  signal?: AbortSignal;
}

export interface QuickOptions {
  content: string;
  systemPrompt: string;
  model: ModelId;
}

export interface ModelInfo {
  id: ModelId;
  label: string;
  quick?: boolean;
}

export interface LLMProvider {
  name: Provider;
  models: ModelInfo[];

  /** Streaming call -- used for review generation */
  generate(opts: GenerateOptions): Promise<string>;

  /** Non-streaming call -- used for smart imports */
  quick(opts: QuickOptions): Promise<string>;
}

const providers: Record<Provider, LLMProvider> = {
  claude: claudeProvider,
  gemini: geminiProvider,
};

export function getProvider(name: Provider): LLMProvider {
  return providers[name];
}
