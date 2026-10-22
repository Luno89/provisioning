export type HubRole = 'owner' | 'collaborator' | 'client';

export const HUB_ROLES: readonly HubRole[] = ['owner', 'collaborator', 'client'];

export type HubAction =
  | 'see-project'
  | 'see-people'
  | 'invite'
  | 'change-roles'
  | 'remove-people'
  | 'see-code'
  | 'approve-changes'
  | 'work-stories'
  | 'release'
  | 'see-secrets'
  | 'change-settings'
  | 'pin-and-comment'
  | 'ask-koala';

const CAN: Record<HubRole, readonly HubAction[]> = {
  owner: ['see-project', 'see-people', 'invite', 'change-roles', 'remove-people', 'see-code', 'approve-changes', 'work-stories', 'release', 'see-secrets', 'change-settings', 'pin-and-comment', 'ask-koala'],
  collaborator: ['see-project', 'see-people', 'see-code', 'approve-changes', 'work-stories', 'pin-and-comment', 'ask-koala'],
  client: ['see-project', 'see-people', 'pin-and-comment', 'ask-koala'],
};

export const can = (role: HubRole | undefined, action: HubAction): boolean => Boolean(role && CAN[role].includes(action));

export const isHubRole = (value: unknown): value is HubRole => HUB_ROLES.includes(value as HubRole);

export interface SharedProject {
  id: string;
  name: string;
  createdAt: string;
  createdBy: string;
  origin?: { instanceId?: string | undefined; projectId: string } | undefined;
  group?: string | undefined;
}

export interface HubMember {
  personId: string;
  email: string;
  role: HubRole;
  joinedAt: string;
  invitedBy?: string | undefined;
}

export interface HubInvite {
  token: string;
  projectId: string;
  email: string;
  role: HubRole;
  invitedBy: string;
  createdAt: string;
}

export const HUB_DATABASE_PREFIX = 'hub_';
export const SHARED_PROJECT_ID = /^[a-f0-9]{24}$/;
export const INVITE_TOKEN = /^[A-Za-z0-9_-]{32}$/;
export const HUB_AUDIENCE = 'hub';

export const projectDatabase = (projectId: string): string => {
  if (!SHARED_PROJECT_ID.test(projectId)) throw new Error(`${projectId} is not a shared project's id`);
  return `${HUB_DATABASE_PREFIX}${projectId}`;
};

export const sameEmail = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function inviteProblem(input: { email: unknown; role: unknown }, members: readonly HubMember[], pending: readonly HubInvite[]): string | undefined {
  if (typeof input.email !== 'string' || !EMAIL.test(input.email.trim())) return 'give the email address of the person to invite';
  if (!isHubRole(input.role)) return `a member is an ${HUB_ROLES.join(', a ')}`;
  if (members.some((member) => sameEmail(member.email, input.email as string))) return `${input.email} is already on this project`;
  if (pending.some((invite) => sameEmail(invite.email, input.email as string))) return `${input.email} is already invited; take that invite back first to send another`;
  return undefined;
}

export function roleChangeProblem(members: readonly HubMember[], personId: string, role: unknown): string | undefined {
  if (!isHubRole(role)) return `a member is an ${HUB_ROLES.join(', a ')}`;
  const member = members.find((entry) => entry.personId === personId);
  if (!member) return 'that person is not on this project';
  if (member.role === 'owner' && role !== 'owner' && members.filter((entry) => entry.role === 'owner').length === 1) return 'a project always keeps one owner; make someone else an owner first';
  return undefined;
}

export function leavingProblem(members: readonly HubMember[], personId: string): string | undefined {
  const member = members.find((entry) => entry.personId === personId);
  if (!member) return 'that person is not on this project';
  if (member.role === 'owner' && members.filter((entry) => entry.role === 'owner').length === 1) return 'the last owner cannot leave; make someone else an owner first';
  return undefined;
}

export type LeavingAll = { kind: 'delete' } | { kind: 'leave' } | { kind: 'blocked'; why: string };

export function leavingAll(project: Pick<SharedProject, 'name'>, members: readonly HubMember[], personId: string): LeavingAll {
  const others = members.filter((member) => member.personId !== personId);
  if (others.length === 0) return { kind: 'delete' };
  const owner = members.find((member) => member.personId === personId)?.role === 'owner';
  if (owner && !others.some((member) => member.role === 'owner')) return { kind: 'blocked', why: `you are the only owner of the shared project "${project.name}", which others are on; make one of them an owner first` };
  return { kind: 'leave' };
}

export function sharedProjectProblem(input: { name: unknown }): string | undefined {
  if (typeof input.name !== 'string' || !input.name.trim()) return 'a shared project needs a name';
  if (input.name.trim().length > 120) return 'a shared project\'s name is at most 120 characters';
  return undefined;
}

export const hubInstancePart = (instanceId: string, personId: string, email: string): string => `instance/${instanceId}/${personId}/${email.trim().toLowerCase()}`;

export interface HubAccess {
  token: string;
  hubUrl: string;
  personId: string;
  email: string;
  instanceId: string;
}
