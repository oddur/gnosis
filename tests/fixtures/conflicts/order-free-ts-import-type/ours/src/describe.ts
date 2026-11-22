import type { User } from './user';
import type { Team } from './team';
import type { Squad } from './squad';

export function describe(user: User): string {
  return user.name;
}
