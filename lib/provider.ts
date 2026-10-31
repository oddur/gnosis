import { claudeProvider } from './providers/claude';
import { codexProvider } from './providers/codex';
import type { ModelId, Provider } from './types';

/** In-memory screenshots; providers own temporary attachment storage and cleanup. */
export interface GenerationImage {
  base64: string;
  mediaType: 'image/png';
}

export interface GenerateOptions {
  images?: GenerationImage[];
  content: string;
  systemPrompt: string;
  model: ModelId;
  thinking: boolean;
  effort?: import('./effort').Effort;
  onChunk?: (chunk: string, isThinking: boolean) => void;
  onToolUse?: (toolName: string) => void;
  mcpConfigPath?: string;
  allowedTools?: string[];
  /** Directory the CLI runs in. When set, project-local config
   *  (.mcp.json, .claude/settings.json, skills) is auto-discovered. */
  cwd?: string;
  /** When true, don't pass --strict-mcp-config — lets the CLI pick up
   *  the project's own `.mcp.json` in addition to any `mcpConfigPath`. */
  nonStrictMcp?: boolean;
  /** Use only supplied context, without built-in tools or user/project settings. */
  isolated?: boolean;
  signal?: AbortSignal;
}

export interface QuickOptions {
  content: string;
  systemPrompt: string;
  model: ModelId;
  cwd?: string;
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
  codex: codexProvider,
};

export function getProvider(name: Provider): LLMProvider {
  return providers[name];
}
