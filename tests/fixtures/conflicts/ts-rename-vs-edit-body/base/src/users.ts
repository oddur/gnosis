export function loadUser(id: string) {
  const row = db.find(id);
  return row ? toUser(row) : undefined;
}

export function handler(id: string) {
  return loadUser(id);
}
