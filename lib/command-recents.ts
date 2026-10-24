export function commandRecents(account: string): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(`gnosis-command-recents:${account}`) ?? '[]');
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string').slice(0, 12) : [];
  } catch {
    return [];
  }
}
export function rememberCommandDestination(account: string, id: string) {
  try {
    localStorage.setItem(
      `gnosis-command-recents:${account}`,
      JSON.stringify([id, ...commandRecents(account).filter((x) => x !== id)].slice(0, 12))
    );
  } catch {
    /* Optional session convenience. */
  }
}
