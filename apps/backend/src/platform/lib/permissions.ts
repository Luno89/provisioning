import type { PlatformRole } from './platform-role.js';

export type SharedRole = 'owner' | 'collaborator' | 'client';

export const SHARED_ROLES: readonly SharedRole[] = ['owner', 'collaborator', 'client'];

export type Claim =
  | { role: 'person' }
  | { role: 'operator' }
  | { role: 'instance-owner' }
  | { role: 'shared'; project: string; as: SharedRole };

export interface Principal {
  kind: 'person';
  id: string;
  claims: readonly Claim[];
}

export interface ClaimSettings {
  role: PlatformRole;
  instanceOwnerId?: string | undefined;
}

export function claimsOf(user: { id: string; isAdmin?: boolean | undefined }, settings: ClaimSettings): Claim[] {
  const claims: Claim[] = [{ role: 'person' }];
  if (settings.role === 'instance') {
    if (settings.instanceOwnerId !== undefined && user.id === settings.instanceOwnerId) claims.push({ role: 'operator' }, { role: 'instance-owner' });
  } else if (settings.role !== 'hub' && user.isAdmin === true) {
    claims.push({ role: 'operator' });
  }
  return claims;
}

export const principalOf = (user: { id: string; isAdmin?: boolean | undefined }, settings: ClaimSettings): Principal =>
  ({ kind: 'person', id: user.id, claims: claimsOf(user, settings) });

export const asPerson = (id: string): Principal => ({ kind: 'person', id, claims: [{ role: 'person' }] });

export const withSharedRole = (principal: Principal, project: string, as: SharedRole): Principal => ({
  ...principal,
  claims: [...principal.claims.filter((claim) => !(claim.role === 'shared' && claim.project === project)), { role: 'shared', project, as }],
});

export const holds = (principal: Principal, role: 'operator' | 'instance-owner'): boolean =>
  principal.claims.some((claim) => claim.role === role);

export const sharedRoleOf = (principal: Principal, project: string): SharedRole | undefined => {
  const claim = principal.claims.find((entry): entry is Extract<Claim, { role: 'shared' }> => entry.role === 'shared' && entry.project === project);
  return claim?.as;
};

export type SharedAction =
  | 'see-project'
  | 'see-people'
  | 'invite'
  | 'change-roles'
  | 'remove-people'
  | 'change-files'
  | 'approve-changes'
  | 'work-stories'
  | 'release'
  | 'see-secrets'
  | 'change-settings'
  | 'pin-and-comment'
  | 'ask-koala';

export interface Actions {
  install: 'administer' | 'manage-accounts' | 'see-all-work' | 'use-operator-credentials' | 'open-platform-namespaces';
  'instance-settings': 'change';
  account: 'remove';
  'system-cluster': 'see' | 'deploy-to' | 'see-everything' | 'change' | 'delete';
  cluster: 'see' | 'deploy-to' | 'see-everything' | 'change' | 'delete';
  deployment: 'see' | 'change';
  project: 'see' | 'change';
  'shared-project': SharedAction;
  record: 'see' | 'change';
  workflow: 'see' | 'cancel';
}

export type ResourceKind = keyof Actions;

export type Resource =
  | { kind: 'install' }
  | { kind: 'instance-settings' }
  | { kind: 'account'; id: string }
  | { kind: 'system-cluster'; id: string }
  | { kind: 'cluster'; id: string; ownerId?: string | undefined }
  | { kind: 'deployment'; ownerId?: string | undefined }
  | { kind: 'project'; ownerId?: string | undefined }
  | { kind: 'shared-project'; id: string }
  | { kind: 'record'; noun: string; ownerId?: string | undefined }
  | { kind: 'workflow'; owner?: string | undefined };

type Who = 'nobody' | 'person' | 'operator' | 'instance-owner' | 'owner' | 'self' | { shared: readonly SharedRole[] };

interface Rule {
  who: readonly Who[];
  hidden: boolean;
  said: string;
}

const OPERATOR = (said: string): Rule => ({ who: ['operator'], hidden: false, said });
const OWN = (said: string): Rule => ({ who: ['owner'], hidden: true, said });
const SHARED = (roles: readonly SharedRole[], said: string): Rule => ({ who: [{ shared: roles }], hidden: false, said });
const EVERY_MEMBER: readonly SharedRole[] = SHARED_ROLES;
const WORKERS: readonly SharedRole[] = ['owner', 'collaborator'];
const OWNERS: readonly SharedRole[] = ['owner'];

export const PERMISSIONS: { readonly [K in ResourceKind]: { readonly [A in Actions[K]]: Rule } } = {
  install: {
    administer: OPERATOR('Only the operator of this server can do that.'),
    'manage-accounts': OPERATOR('Only the operator of this server manages accounts.'),
    'see-all-work': OPERATOR('Only the operator of this server sees everyone\'s work.'),
    'use-operator-credentials': OPERATOR('Only the operator of this server uses its own cloud credentials.'),
    'open-platform-namespaces': OPERATOR('Only the operator of this server can open the platform\'s own namespaces.'),
  },
  'instance-settings': {
    change: { who: ['instance-owner'], hidden: false, said: 'Only the owner of this instance changes its settings.' },
  },
  account: {
    remove: { who: ['self', 'operator'], hidden: false, said: 'Only an admin can remove someone else\'s account' },
  },
  'system-cluster': {
    see: { who: ['person'], hidden: true, said: 'Cluster not found' },
    'deploy-to': { who: ['person'], hidden: false, said: 'You cannot deploy to this cluster.' },
    'see-everything': { who: ['operator'], hidden: true, said: 'Cluster not found' },
    change: { who: ['operator'], hidden: false, said: 'Only the operator of this server can change the system cluster.' },
    delete: { who: ['nobody'], hidden: false, said: 'The system cluster cannot be deleted' },
  },
  cluster: {
    see: OWN('Cluster not found'),
    'deploy-to': OWN('Cluster not found'),
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
    change: OWN('Project not found'),
  },
  'shared-project': {
    'see-project': SHARED(EVERY_MEMBER, 'That shared project does not exist, or you are not on it.'),
    'see-people': SHARED(EVERY_MEMBER, 'You cannot see who is on this project.'),
    invite: SHARED(OWNERS, 'Only an owner can invite people to this project.'),
    'change-roles': SHARED(OWNERS, 'Only an owner can change what people may do.'),
    'remove-people': SHARED(OWNERS, 'Only an owner can remove people.'),
    'change-files': SHARED(WORKERS, 'Only an owner or a collaborator can move, remove or replace files.'),
    'approve-changes': SHARED(WORKERS, 'Only an owner or a collaborator can change the work.'),
    'work-stories': SHARED(WORKERS, 'Only an owner or a collaborator can work the stories.'),
    release: SHARED(OWNERS, 'Only an owner can release this project.'),
    'see-secrets': SHARED(OWNERS, 'Only an owner can see this project\'s secrets.'),
    'change-settings': SHARED(OWNERS, 'Only an owner can change or delete this project.'),
    'pin-and-comment': SHARED(EVERY_MEMBER, 'You cannot post on this project.'),
    'ask-koala': SHARED(['owner', 'client'], 'Koala answers a collaborator from their own instance, once it is linked to this project'),
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
  if (resource.kind !== 'shared-project') return false;
  const role = sharedRoleOf(principal, resource.id);
  return role !== undefined && who.shared.includes(role);
}

export function ruleFor<K extends ResourceKind>(kind: K, action: Actions[K]): Rule {
  return (PERMISSIONS[kind] as Record<string, Rule>)[action as string]!;
}

export function authorize<R extends Resource>(principal: Principal, action: Actions[R['kind']], resource: R): Decision {
  const rule = ruleFor(resource.kind, action);
  if (rule.who.some((who) => satisfies(principal, who, resource))) return { allowed: true };
  return { allowed: false, status: rule.hidden ? 404 : 403, error: rule.said };
}

export const allowed = <R extends Resource>(principal: Principal, action: Actions[R['kind']], resource: R): boolean =>
  authorize(principal, action, resource).allowed;

export const clusterResource = (cluster: { id: string; ownerId?: string | undefined; isSystem?: boolean | undefined }): Resource =>
  cluster.isSystem === true ? { kind: 'system-cluster', id: cluster.id } : { kind: 'cluster', id: cluster.id, ownerId: cluster.ownerId };

export const sharedActionsOf = (principal: Principal, project: string): SharedAction[] =>
  (Object.keys(PERMISSIONS['shared-project']) as SharedAction[]).filter((action) => allowed(principal, action, { kind: 'shared-project', id: project }));

export const rolePrincipal = (id: string, project: string, as: SharedRole): Principal =>
  ({ kind: 'person', id, claims: [{ role: 'person' }, { role: 'shared', project, as }] });
