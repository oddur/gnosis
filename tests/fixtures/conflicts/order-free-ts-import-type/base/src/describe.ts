import type { User } from './user';

export function describe(user: User): string {
  return user.name;
}
