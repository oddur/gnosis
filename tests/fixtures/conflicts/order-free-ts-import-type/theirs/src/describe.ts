import type { User } from './user';
import type { Role } from './role';

export function describe(user: User): string {
  return user.name;
}
