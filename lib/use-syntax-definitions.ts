import { useEffect, useState } from 'react';
import { syntaxLanguage, type SyntaxDefinition } from './syntax-scope';
import { peekDefinitions, readDefinitions } from './syntax-scope-client';
import type { SyntaxPriority } from './syntax-parse-queue';

export interface FileDefinitions {
  after?: readonly SyntaxDefinition[];
  before?: readonly SyntaxDefinition[];
  /** The worker is still parsing the after side the view has: the breadcrumbs are on their way. */
  parsing?: boolean;
  /** The old side is on its way: the outline waits for it to find removed symbols. */
  beforeParsing?: boolean;
}
const NONE: FileDefinitions = {};

/**
 * The definitions of a file revision's two sides, parsed in the worker (#393). Only text the reader's view already
 * has is parsed, so this adds no reads. Known definitions return in the same render; others arrive later, each side
 * on its own: the after side names the hunks, so the breadcrumbs show as soon as it is parsed, and the old side, which
 * the outline and hunks that only delete use, follows. A file without a grammar, or whose parse fails, has none.
 * `priority` is where the file is (lib/syntax-parse-queue.ts); a file that comes on screen asks again, and its parse
 * moves up.
 */
export function useSyntaxDefinitions({
  key,
  url,
  path,
  previousPath,
  after,
  before,
  enabled,
  priority = 'view',
}: {
  key: string;
  url: string;
  path: string;
  previousPath?: string;
  after?: string;
  before?: string;
  enabled: boolean;
  priority?: SyntaxPriority;
}): FileDefinitions {
  const afterLanguage = enabled && after !== undefined ? syntaxLanguage(path) : undefined;
  const beforeLanguage = enabled && before !== undefined ? syntaxLanguage(previousPath ?? path) : undefined;
  const afterKey = `${key}:after`,
    beforeKey = `${key}:before`;
  // Each side's result once its parse ended: its definitions, or undefined when it had none.
  const [state, setState] = useState<{ id: string; after?: { value?: SyntaxDefinition[] }; before?: { value?: SyntaxDefinition[] } }>();
  const id = `${afterKey}|${afterLanguage ?? ''}|${beforeLanguage ?? ''}`;
  useEffect(() => {
    if (!afterLanguage && !beforeLanguage) return;
    let cancelled = false;
    const read = (side: 'after' | 'before') => {
      const language = side === 'after' ? afterLanguage : beforeLanguage;
      const text = side === 'after' ? after : before;
      if (!language || text === undefined) return;
      void readDefinitions({ key: side === 'after' ? afterKey : beforeKey, url, language, text, priority })
        .catch(() => undefined)
        .then((value) => {
          if (!cancelled)
            setState((previous) => ({ ...(previous?.id === id ? previous : { id }), [side]: { value } }));
        });
    };
    read('after');
    read('before');
    return () => {
      cancelled = true;
    };
  }, [id, after, before, priority]);
  if (!afterLanguage && !beforeLanguage) return NONE;
  const current = state?.id === id ? state : undefined;
  const afterDefinitions = afterLanguage ? (current?.after ? current.after.value : peekDefinitions(afterKey)) : undefined;
  const beforeDefinitions = beforeLanguage ? (current?.before ? current.before.value : peekDefinitions(beforeKey)) : undefined;
  return {
    after: afterDefinitions,
    before: beforeDefinitions,
    parsing: !!afterLanguage && !current?.after && !afterDefinitions,
    beforeParsing: !!beforeLanguage && !current?.before && !beforeDefinitions,
  };
}
