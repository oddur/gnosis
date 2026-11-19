/**
 * Icons Gnosis never uses. Sparkles, in any variant, is banned: it is the generic "AI" mark and says nothing about
 * what a control does. AI actions use the Bot icon instead. tests/banned-icons.test.ts enforces this across the
 * source, and scripts/sync-lucide-icons.mjs leaves these out of the repository icon picker.
 */
export const BANNED_ICON_PATTERN = /sparkle/i;
/** Whether a lucide name (`wand-sparkles`) or component (`WandSparkles`) is banned. */
export const bannedIconName = (name) => BANNED_ICON_PATTERN.test(name);
