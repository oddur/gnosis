/**
 * What each chat surface remembers: the width of its side panel and the model its next question goes to.
 *
 * A surface is where a conversation docks: `topic` beside an Explanation topic, `file` beside Changes, Commits and
 * Feedback. Each keeps its own width and model in preferences, so widening the file chat leaves the topic chat as it
 * was. Values are validated on every read: preferences are user data, and an unknown model or a width out of range
 * falls back to the default instead of reaching the CLI or the layout. No React imports.
 */
import {
  normalizeModelSelection,
  PROVIDERS,
  RETIRED_CLAUDE_MODELS,
  RETIRED_CODEX_MODELS,
  type ModelId,
  type Provider,
} from './models';
import type { Preferences } from './types';
import { normalizeChatContextBudget } from './chat-pr-context';

/** What chat writes through main's narrow save-chat-preferences. */
export type ChatPreferencesPatch = Partial<Pick<Preferences, 'chatPanelWidths' | 'chatModels' | 'chatContextTokens'>>;

export type ChatSurface = 'topic' | 'file';
export const CHAT_SURFACES: readonly ChatSurface[] = ['topic', 'file'];

export const CHAT_PANEL_MIN_WIDTH = 320;
export const CHAT_PANEL_MAX_WIDTH = 720;
/** DESIGN.md › The chat tier: chat sits in a 400px side panel beside code. */
export const CHAT_PANEL_DEFAULT_WIDTH = 400;
/** One arrow key press; Shift moves ten times as far, as a slider does. */
export const CHAT_PANEL_STEP = 16;

export interface ChatModelChoice {
  provider: Provider;
  model: ModelId;
}

export type ChatPanelWidths = Partial<Record<ChatSurface, number>>;
export type ChatModels = Partial<Record<ChatSurface, ChatModelChoice>>;

const isSurface = (value: string): value is ChatSurface => (CHAT_SURFACES as readonly string[]).includes(value);

export function clampChatPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return CHAT_PANEL_DEFAULT_WIDTH;
  return Math.round(Math.min(CHAT_PANEL_MAX_WIDTH, Math.max(CHAT_PANEL_MIN_WIDTH, width)));
}

/** Saved widths, without entries that are not numbers or name no surface. Values are clamped to the range. */
export function normalizeChatPanelWidths(value: unknown): ChatPanelWidths {
  if (!value || typeof value !== 'object') return {};
  const widths: ChatPanelWidths = {};
  for (const [surface, width] of Object.entries(value))
    if (isSurface(surface) && typeof width === 'number' && Number.isFinite(width))
      widths[surface] = clampChatPanelWidth(width);
  return widths;
}

/** A saved choice its provider still offers; a retired model moves to its successor, an unknown one is dropped. */
export function normalizeChatModels(value: unknown): ChatModels {
  if (!value || typeof value !== 'object') return {};
  const models: ChatModels = {};
  for (const [surface, choice] of Object.entries(value)) {
    if (!isSurface(surface) || !choice || typeof choice !== 'object') continue;
    const { provider, model } = choice as { provider?: unknown; model?: unknown };
    if (provider !== 'claude' && provider !== 'codex') continue;
    const retired: Record<string, unknown> = provider === 'claude' ? RETIRED_CLAUDE_MODELS : RETIRED_CODEX_MODELS;
    const known =
      PROVIDERS[provider].models.some((m) => m.id === model) ||
      (typeof model === 'string' && Object.prototype.hasOwnProperty.call(retired, model));
    if (!known) continue;
    models[surface] = normalizeModelSelection(provider, model);
  }
  return models;
}

export function chatPanelWidth(preferences: Pick<Preferences, 'chatPanelWidths'> | undefined, surface: ChatSurface) {
  return normalizeChatPanelWidths(preferences?.chatPanelWidths)[surface] ?? CHAT_PANEL_DEFAULT_WIDTH;
}

/** The surface's own choice, else the general model preference, the model chat has always used. */
export function chatModelChoice(
  preferences: Partial<Pick<Preferences, 'chatModels' | 'provider' | 'model'>> | undefined,
  surface: ChatSurface
): ChatModelChoice {
  return (
    normalizeChatModels(preferences?.chatModels)[surface] ??
    normalizeModelSelection(preferences?.provider ?? 'claude', preferences?.model)
  );
}

export function chatModelLabel(choice: ChatModelChoice): string {
  return PROVIDERS[choice.provider].models.find((m) => m.id === choice.model)?.label ?? choice.model;
}

/** Every model the providers offer, grouped by provider, in the order the model settings list them. */
export function chatModelOptions(): { provider: Provider; label: string; models: { id: ModelId; label: string }[] }[] {
  return (Object.keys(PROVIDERS) as Provider[]).map((provider) => ({
    provider,
    label: PROVIDERS[provider].label,
    models: PROVIDERS[provider].models.map((m) => ({ id: m.id, label: m.label })),
  }));
}

/** The chat context size, kept for both chats: a preset, else the default. */
export function chatContextBudget(preferences: Partial<Pick<Preferences, 'chatContextTokens'>> | undefined) {
  return normalizeChatContextBudget(preferences?.chatContextTokens);
}

interface PreferencesStore {
  loadPreferences: () => Promise<Preferences>;
  savePreferences?: (preferences: Preferences) => Promise<unknown>;
  /** Main's narrow write for these two fields, without the settings side effects of savePreferences. */
  saveChatPreferences?: (patch: ChatPreferencesPatch) => Promise<unknown>;
}

/**
 * Writes one surface's value into the saved preferences, read fresh so a change made elsewhere is kept. Writes run in
 * order, and a failed write does not stop the next. Only the chat fields go through saveChatPreferences; the full
 * savePreferences is a fallback for hosts without it.
 */
export function createChatPreferenceWriter(store: () => PreferencesStore | undefined) {
  let writes: Promise<void> = Promise.resolve();
  const write = (patch: (preferences: Preferences) => ChatPreferencesPatch) => {
    writes = writes
      .catch(() => {})
      .then(async () => {
        const api = store();
        if (!api?.saveChatPreferences && !api?.savePreferences) return;
        const current = await api.loadPreferences();
        const change = patch(current);
        if (api.saveChatPreferences) await api.saveChatPreferences(change);
        else await api.savePreferences?.({ ...current, ...change });
      });
    return writes;
  };
  return {
    width: (surface: ChatSurface, width: number | undefined) =>
      write((current) => {
        const widths = Object.entries(normalizeChatPanelWidths(current.chatPanelWidths)).filter(([s]) => s !== surface);
        if (width !== undefined) widths.push([surface, clampChatPanelWidth(width)]);
        return { chatPanelWidths: Object.fromEntries(widths) as ChatPanelWidths };
      }),
    contextTokens: (tokens: number) => write(() => ({ chatContextTokens: normalizeChatContextBudget(tokens) })),
    model: (surface: ChatSurface, choice: ChatModelChoice) =>
      write((current) => ({
        chatModels: { ...normalizeChatModels(current.chatModels), ...normalizeChatModels({ [surface]: choice }) },
      })),
  };
}

/**
 * The renderer's values, seeded from the startup preferences and kept here once changed, so a panel that closes and
 * opens again, or a second tab, sees the latest choice before its write is read back.
 */
const remembered: { widths: ChatPanelWidths; models: ChatModels; contextTokens?: number } = { widths: {}, models: {} };
const writer = createChatPreferenceWriter(
  () => (globalThis as { window?: { electronAPI?: PreferencesStore } }).window?.electronAPI
);

export function rememberedChatPanelWidth(preferences: Preferences | undefined, surface: ChatSurface): number {
  return remembered.widths[surface] ?? chatPanelWidth(preferences, surface);
}
export function rememberChatPanelWidth(surface: ChatSurface, width: number | undefined) {
  // A reset is remembered as the default, so the stale saved width is not read back before the write lands.
  remembered.widths = { ...remembered.widths, [surface]: clampChatPanelWidth(width ?? CHAT_PANEL_DEFAULT_WIDTH) };
  return writer.width(surface, width);
}
export function rememberedChatModel(
  preferences: Partial<Pick<Preferences, 'chatModels' | 'provider' | 'model'>> | undefined,
  surface: ChatSurface
): ChatModelChoice {
  return remembered.models[surface] ?? chatModelChoice(preferences, surface);
}
export function rememberedChatContextBudget(preferences: Partial<Pick<Preferences, 'chatContextTokens'>> | undefined) {
  return normalizeChatContextBudget(remembered.contextTokens ?? preferences?.chatContextTokens);
}
export function rememberChatContextBudget(tokens: number) {
  remembered.contextTokens = normalizeChatContextBudget(tokens);
  return writer.contextTokens(tokens);
}
export function rememberChatModel(surface: ChatSurface, choice: ChatModelChoice) {
  remembered.models[surface] = choice;
  return writer.model(surface, choice);
}
