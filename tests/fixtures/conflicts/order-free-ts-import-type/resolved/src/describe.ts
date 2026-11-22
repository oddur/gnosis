import type { User } from './user';
import type { Team } from './team';
import type { Role } from './role';

export function describe(user: User): string {
  return user.name;
}
