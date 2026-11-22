import { db, toUser, type User } from './db';

export function userLabel(user: User): string {
  return `${user.name} <${user.email}>`;
}

export function sortUsers(users: User[]): User[] {
  const sorted = [...users];
  sorted.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.email.localeCompare(b.email);
  });
  return sorted;
}

export function activeUsers(users: User[], since: Date): User[] {
  const result: User[] = [];
  for (const user of users) {
    if (user.lastSeen && user.lastSeen >= since) result.push(user);
  }
  return result;
}

export function handler(id: string, cache: Map<string, User>) {
  return findUser(id, cache);
}

export function findUser(id: string, cache: Map<string, User>): User | undefined {
  const cached = cache.get(id);
  if (cached) return cached;
  const row = db.find(id);
  const user = row ? toUser(row) : undefined;
  if (user) cache.set(id, user);
  return user;
}
