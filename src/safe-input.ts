/**
 * Checks for values that cross from the renderer, or from rendered content, into the file system or the OS.
 */

// Saved review ids are UUIDs and become file names under the reviews folder. Anything else is refused,
// so an id can never reach another path (for example "../preferences").
const REVIEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isReviewId(id: unknown): id is string {
  return typeof id === 'string' && REVIEW_ID.test(id);
}

export function assertReviewId(id: unknown): asserts id is string {
  if (!isReviewId(id)) throw new Error('Invalid saved review.');
}

// Only web and mail links leave the app. file:, javascript: and other registered app schemes from rendered
// content (PR descriptions, explanations, comments) must never reach shell.openExternal.
const EXTERNAL_SCHEMES = new Set(['https:', 'http:', 'mailto:']);

/** The URL to open in the user's browser or mail app, or null when it must not leave the app. */
export function safeExternalUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return EXTERNAL_SCHEMES.has(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
}
