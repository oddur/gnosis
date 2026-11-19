import { useEffect, useState } from 'react';
import { syntaxLanguage, type SyntaxDefinition } from './syntax-scope';
import { peekDefinitions, readDefinitions } from './syntax-scope-client';

export interface FileDefinitions {
  after?: readonly SyntaxDefinition[];
  before?: readonly SyntaxDefinition[];
  /** The worker is still parsing text the view has: the definitions are on their way. */
  parsing?: boolean;
}
const NONE: FileDefinitions = {};
const PARSING: FileDefinitions = { parsing: true };

/**
 * The definitions of a file revision's two sides, parsed in the worker (#393). Only text the reader's view already
 * has is parsed, so this adds no reads. Known definitions return in the same render; others arrive later, and a
 * file without a grammar, or whose parse fails, has none.
 */
export function useSyntaxDefinitions({
  key,
  url,
  path,
  previousPath,
  after,
  before,
  enabled,
}: {
  key: string;
  url: string;
  path: string;
  previousPath?: string;
  after?: string;
  before?: string;
  enabled: boolean;
}): FileDefinitions {
  const afterLanguage = enabled && after !== undefined ? syntaxLanguage(path) : undefined;
  const beforeLanguage = enabled && before !== undefined ? syntaxLanguage(previousPath ?? path) : undefined;
  const afterKey = `${key}:after`,
    beforeKey = `${key}:before`;
  const known = (): FileDefinitions => ({
    after: afterLanguage ? peekDefinitions(afterKey) : undefined,
    before: beforeLanguage ? peekDefinitions(beforeKey) : undefined,
  });
  const [state, setState] = useState<{ id: string; value: FileDefinitions }>();
  const id = `${afterKey}|${afterLanguage ?? ''}|${beforeLanguage ?? ''}`;
  useEffect(() => {
    if (!afterLanguage && !beforeLanguage) return;
    let cancelled = false;
    const read = (side: 'after' | 'before') => {
      const language = side === 'after' ? afterLanguage : beforeLanguage;
      const text = side === 'after' ? after : before;
      if (!language || text === undefined) return Promise.resolve(undefined);
      return readDefinitions({ key: side === 'after' ? afterKey : beforeKey, url, language, text }).catch(
        () => undefined
      );
    };
    void Promise.all([read('after'), read('before')]).then(([afterDefinitions, beforeDefinitions]) => {
      if (!cancelled) setState({ id, value: { after: afterDefinitions, before: beforeDefinitions } });
    });
    return () => {
      cancelled = true;
    };
  }, [id, after, before]);
  if (!afterLanguage && !beforeLanguage) return NONE;
  if (state?.id === id) return state.value;
  const peeked = known();
  return peeked.after || peeked.before ? peeked : PARSING;
}
