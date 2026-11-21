import type { PlatformRole } from './platform-role.js';
import type { PlatformGrant } from './types.js';
import { noteOnSpan } from '@koala/engine-core/telemetry';

export type Claim =
  | { role: 'person' }
  | { role: 'operator' }
  | { role: 'instance-owner' }
  | { role: 'space-of'; person: string };

export interface Principal {
  kind: 'person';
  id: string;
  claims: readonly Claim[];
}

export interface ClaimSettings {
  role: PlatformRole;
  instanceOwnerId?: string | undefined;
}

export interface ClaimedUser { id: string; roles?: readonly PlatformGrant[] | undefined; space?: { person: string } | undefined }

export function claimsOf(user: ClaimedUser, settings: ClaimSettings): Claim[] {
  const claims: Claim[] = [{ role: 'person' }];
  if (user.space?.person) return [...claims, { role: 'space-of', person: user.space.person }];
  if (settings.role === 'instance') {
    if (settings.instanceOwnerId !== undefined && user.id === settings.instanceOwnerId) claims.push({ role: 'operator' }, { role: 'instance-owner' });
  } else if (settings.role === 'root' && (user.roles ?? []).includes('operator')) {
    claims.push({ role: 'operator' });
  }
  return claims;
}

export const principalOf = (user: ClaimedUser, settings: ClaimSettings): Principal =>
  ({ kind: 'person', id: user.id, claims: claimsOf(user, settings) });

export const asPerson = (id: string): Principal => ({ kind: 'person', id, claims: [{ role: 'person' }] });

export const holds = (principal: Principal, role: 'operator' | 'instance-owner'): boolean =>
  principal.claims.some((claim) => claim.role === role);

export const operatorsAmong = <T extends ClaimedUser & { space?: unknown }>(users: readonly T[], settings: ClaimSettings): T[] =>
  users.filter((user) => !user.space && holds(principalOf(user, settings), 'operator'));

export interface Actions {
  install: 'administer' | 'manage-accounts' | 'see-all-work' | 'use-operator-credentials' | 'open-platform-namespaces' | 'see-platform-dependencies' | 'set-up-again';
  'instance-settings': 'change';
  account: 'remove';
  cluster: 'see' | 'deploy-to' | 'see-everything' | 'change' | 'delete';
  deployment: 'see' | 'change';
  project: 'see' | 'propose' | 'change' | 'see-secrets' | 'see-env';
  record: 'see' | 'change';
  workflow: 'see' | 'cancel';
}

export type ResourceKind = keyof Actions;

export type Resource =
  | { kind: 'install' }
  | { kind: 'instance-settings' }
  | { kind: 'account'; id: string }
  | { kind: 'cluster'; id: string; ownerId?: string | undefined }
  | { kind: 'deployment'; ownerId?: string | undefined }
  | { kind: 'project'; id?: string | undefined; ownerId?: string | undefined }
  | { kind: 'record'; noun: string; ownerId?: string | undefined }
  | { kind: 'workflow'; owner?: string | undefined };

type Who = 'nobody' | 'person' | 'operator' | 'instance-owner' | 'owner' | 'owners-space' | 'self';

interface Rule {
  who: readonly Who[];
  hidden: boolean;
  said: string;
}

const OPERATOR = (said: string): Rule => ({ who: ['operator'], hidden: false, said });
const OWN = (said: string): Rule => ({ who: ['owner'], hidden: true, said });

export const PERMISSIONS: { readonly [K in ResourceKind]: { readonly [A in Actions[K]]: Rule } } = {
  install: {
    administer: OPERATOR('Only the operator of this server can do that.'),
    'manage-accounts': OPERATOR('Only the operator of this server manages accounts.'),
    'see-all-work': OPERATOR('Only the operator of this server sees everyone\'s work.'),
    'use-operator-credentials': OPERATOR('Only the operator of this server uses its own cloud credentials.'),
    'open-platform-namespaces': OPERATOR('Only the operator of this server can open the platform\'s own namespaces.'),
    'see-platform-dependencies': { who: ['operator', 'instance-owner'], hidden: false, said: 'Only whoever runs this Koala sees whether the services it depends on answer.' },
    'set-up-again': { who: ['operator', 'instance-owner'], hidden: false, said: 'Only whoever runs this Koala sets it up again.' },
  },
  'instance-settings': {
    change: { who: ['instance-owner'], hidden: false, said: 'Only the owner of this instance changes its settings.' },
  },
  account: {
    remove: { who: ['self', 'operator'], hidden: false, said: 'Only an admin can remove someone else\'s account' },
  },
  cluster: {
    see: { who: ['owner', 'owners-space'], hidden: true, said: 'Cluster not found' },
    'deploy-to': { who: ['owner', 'owners-space'], hidden: true, said: 'Cluster not found' },
    'see-everything': OWN('Cluster not found'),
    change: OWN('Cluster not found'),
    delete: OWN('Cluster not found'),
  },
  deployment: {
    see: OWN('Deployment not found'),
    change: OWN('Deployment not found'),
  },
  project: {
    see: OWN('Project not found'),
    propose: { who: ['owner'], hidden: false, said: 'Only the owner can propose changes to this project.' },
    change: { who: ['owner'], hidden: false, said: 'Only the owner can change this project.' },
    'see-secrets': { who: ['owner'], hidden: false, said: 'Only the owner can see this project\'s secrets.' },
    'see-env': { who: ['owner'], hidden: false, said: 'Only the owner can see this project\'s environment.' },
  },
  record: {
    see: OWN('Not found'),
    change: OWN('Not found'),
  },
  workflow: {
    see: { who: ['owner', 'operator'], hidden: true, said: 'Workflow not found' },
    cancel: { who: ['owner', 'operator'], hidden: true, said: 'Workflow not found' },
  },
};

export type Decision = { allowed: true } | { allowed: false; status: 403 | 404; error: string };

const ownerOf = (resource: Resource): string | undefined => {
  switch (resource.kind) {
    case 'cluster':
    case 'deployment':
    case 'project':
    case 'record':
      return resource.ownerId;
    case 'workflow':
      return resource.owner;
    default:
      return undefined;
  }
};

function satisfies(principal: Principal, who: Who, resource: Resource): boolean {
  if (who === 'nobody') return false;
  if (who === 'person') return principal.claims.some((claim) => claim.role === 'person');
  if (who === 'operator') return holds(principal, 'operator');
  if (who === 'instance-owner') return holds(principal, 'instance-owner');
  if (who === 'self') return resource.kind === 'account' && resource.id === principal.id;
  if (who === 'owner') {
    const owner = ownerOf(resource);
    return owner !== undefined && owner !== '' && owner === principal.id;
  }
  if (who === 'owners-space') {
    const owner = ownerOf(resource);
    return owner !== undefined && owner !== '' && principal.claims.some((claim) => claim.role === 'space-of' && claim.person === owner);
  }
  return false;
}

export function ruleFor<K extends ResourceKind>(kind: K, action: Actions[K]): Rule {
  return (PERMISSIONS[kind] as Record<string, Rule>)[action as string]!;
}

const DECIDING_CODE = /platform\/(lib\/permissions|middleware\/auth)\.ts$/;

export function authorize<R extends Resource>(principal: Principal, action: Actions[R['kind']], resource: R): Decision {
  const rule = ruleFor(resource.kind, action);
  if (rule.who.some((who) => satisfies(principal, who, resource))) return { allowed: true };
  const status = rule.hidden ? 404 : 403;
  noteOnSpan('koala.refused', { 'koala.action': String(action), 'koala.resource': resource.kind, 'koala.claims': [...new Set(principal.claims.map((claim) => claim.role))].join(','), 'koala.status': status }, DECIDING_CODE);
  return { allowed: false, status, error: rule.said };
}

export const allowed = <R extends Resource>(principal: Principal, action: Actions[R['kind']], resource: R): boolean =>
  authorize(principal, action, resource).allowed;

export const clusterResource = (cluster: { id: string; ownerId?: string | undefined }): Resource =>
  ({ kind: 'cluster', id: cluster.id, ownerId: cluster.ownerId });

export const SESSION_PERMISSIONS = ['administer', 'manage-accounts', 'see-all-work', 'open-platform-namespaces', 'change-instance-settings', 'manage-own-account', 'set-up-again'] as const;

export type SessionPermission = typeof SESSION_PERMISSIONS[number];

export interface SessionPlace {
  holdsAccounts: boolean;
}

export function sessionPermissions(principal: Principal, place: SessionPlace): Record<SessionPermission, boolean> {
  const install = { kind: 'install' } as const;
  return {
    administer: allowed(principal, 'administer', install),
    'manage-accounts': place.holdsAccounts && allowed(principal, 'manage-accounts', install),
    'see-all-work': allowed(principal, 'see-all-work', install),
    'open-platform-namespaces': allowed(principal, 'open-platform-namespaces', install),
    'change-instance-settings': allowed(principal, 'change', { kind: 'instance-settings' }),
    'manage-own-account': place.holdsAccounts && allowed(principal, 'remove', { kind: 'account', id: principal.id }),
    'set-up-again': allowed(principal, 'set-up-again', install),
  };
}

export interface SessionView {
  id: string;
  email: string;
  claims: readonly Claim[];
  permissions: Record<SessionPermission, boolean>;
}

export const sessionView = (user: { id: string; email: string }, principal: Principal, place: SessionPlace): SessionView =>
  ({ id: user.id, email: user.email, claims: principal.claims, permissions: sessionPermissions(principal, place) });
