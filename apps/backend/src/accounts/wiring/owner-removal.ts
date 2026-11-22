import { OWNER_REMOVING } from '../lib/account-removal.js';
import type { OwnerRemoval } from '../services/OwnerRemoval.js';

export interface RootHeard {
  hear(event: string, handler: () => void): void;
}

export function wireOwnerRemoval(root: RootHeard, removal: Pick<OwnerRemoval, 'check'>): void {
  const check = (why: 'told' | 'connected') => () => {
    removal.check(why).catch((err: Error) => console.warn(`[accounts] whether root is removing this Koala's owner could not be checked: ${err.message}; root tells it again`));
  };
  root.hear(OWNER_REMOVING, check('told'));
  root.hear('connect', check('connected'));
  check('connected')();
}
