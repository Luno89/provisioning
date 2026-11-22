import { ACCOUNT_OPEN, AUTH_OPEN, PASSWORD_OPEN } from './accounts/index.js';
import { CHECKS_OPEN } from './checks/index.js';
import { SHARE_OPEN } from './files/index.js';
import { IDENTITY_OPEN, INSTANCES_OPEN, SIGN_IN_OPEN } from './instances/index.js';
import { ACCOUNT_MACHINES_OPEN, MACHINES_OPEN } from './machines/index.js';
import type { OpenMount, PlatformRole } from './platform/index.js';

const BOTH: readonly OpenMount[] = [
  { mount: '/machines', routes: MACHINES_OPEN },
  { mount: '/', routes: ['/metrics'] },
];

const BY_ROLE: Record<PlatformRole, readonly OpenMount[]> = {
  root: [
    { mount: '/auth', routes: AUTH_OPEN },
    { mount: '/auth/password', routes: PASSWORD_OPEN },
    { mount: '/account', routes: ACCOUNT_OPEN },
    { mount: '/identity', routes: IDENTITY_OPEN },
    { mount: '/instances/machines', routes: ACCOUNT_MACHINES_OPEN },
    { mount: '/instances', routes: INSTANCES_OPEN },
  ],
  instance: [
    { mount: '/auth', routes: SIGN_IN_OPEN },
    { mount: '/checks', routes: CHECKS_OPEN },
    { mount: '/share', routes: SHARE_OPEN },
  ],
};

export const openRoutesOf = (role: PlatformRole): readonly OpenMount[] => [...BY_ROLE[role], ...BOTH];
