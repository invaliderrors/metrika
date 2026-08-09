import { getClient } from '@metrika/database';

export function make(): unknown {
  return getClient();
}
