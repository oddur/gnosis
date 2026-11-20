export function loadUser(id: string) {
  const row = db.find(id.trim());
  return row ? toUser(row) : undefined;
}

export function handler(id: string) {
  return loadUser(id);
}
