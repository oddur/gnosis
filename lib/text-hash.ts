/** A 32-bit FNV-1a hash of `text`, in base 36: tells one text from another in a cache key, without keeping the text. */
export function textHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(36);
}
