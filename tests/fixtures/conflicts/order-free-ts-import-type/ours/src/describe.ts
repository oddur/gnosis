import type { User } from './user';
import type { Team } from './team';

export function describe(user: User): string {
  return user.name;
}
