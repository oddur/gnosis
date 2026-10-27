import { buildExplanationMarkdown, type ExplanationMarkdownRequest } from '../lib/explanation-markdown';
import { parentPort } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { buildMarkdownReview } from '../lib/markdown-review-engine';
import type { MarkdownReview, MarkdownReviewRequest } from '../lib/markdown-review';
const port = parentPort;
if (!port) throw new Error('Markdown comparison must run in a worker.');
const cache = new Map<string, { value: MarkdownReview; bytes: number }>();
let bytes = 0;
port.on('message', (message: { id: number; request: MarkdownReviewRequest | ExplanationMarkdownRequest }) => {
  void (async () => {
    try {
      const key = createHash('sha256').update(JSON.stringify(message.request)).digest('hex');
      let entry = cache.get(key);
      if (!entry) {
        const value = await ('kind' in message.request
          ? buildExplanationMarkdown(message.request)
          : buildMarkdownReview(message.request));
        entry = { value, bytes: JSON.stringify(value).length * 2 };
        if (entry.bytes > 16 * 1024 * 1024)
          throw new Error('This document is too complex for rendered comparison. Use Source to review it.');
        if (entry.bytes <= 16 * 1024 * 1024) {
          bytes += entry.bytes;
          cache.set(key, entry);
        }
      } else {
        cache.delete(key);
        cache.set(key, entry);
      }
      while (bytes > 32 * 1024 * 1024 || cache.size > 32) {
        const first = cache.keys().next().value;
        if (first === undefined) break;
        bytes -= cache.get(first)?.bytes ?? 0;
        cache.delete(first);
      }
      port.postMessage({ id: message.id, value: entry.value });
    } catch (error) {
      port.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
  })();
});
