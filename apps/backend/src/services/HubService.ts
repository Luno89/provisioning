import { randomBytes } from 'node:crypto';
import {
  can, inviteProblem, INVITE_TOKEN, leavingProblem, roleChangeProblem, sameEmail, SHARED_PROJECT_ID, sharedProjectProblem,
  type HubAction, type HubInvite, type HubMember, type HubRole, type SharedProject,
} from '../lib/hub.js';
import type { HubStore, SharedProjectStore } from '../lib/hub-store.js';

export interface Person {
  id: string;
  email: string;
}

export interface InviteSender {
  send(request: { email: string; inviterId: string; inviterEmail: string; projectName: string; role: string; join: string }): Promise<{ link: string; emailed: boolean; why?: string | undefined }>;
}

export interface HubServiceDeps {
  store: HubStore;
  invites: InviteSender;
  now?: (() => string) | undefined;
}

export type HubOutcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404 | 409; why: string };

export interface ProjectView {
  project: SharedProject;
  role: HubRole;
  can: HubAction[];
  members?: HubMember[] | undefined;
  invites?: Omit<HubInvite, 'token'>[] | undefined;
}

interface Access {
  project: SharedProject;
  store: SharedProjectStore;
  member: HubMember;
  members: HubMember[];
}

const ACTIONS: readonly HubAction[] = ['see-project', 'see-people', 'invite', 'change-roles', 'remove-people', 'see-code', 'approve-changes', 'work-stories', 'release', 'see-secrets', 'change-settings', 'pin-and-comment', 'ask-koala'];
const NOT_FOUND = { ok: false as const, status: 404 as const, why: 'There is no such project, or you are not on it.' };
const refuse = (why: string) => ({ ok: false as const, status: 403 as const, why });
const wrong = (why: string) => ({ ok: false as const, status: 400 as const, why });

export class HubService {
  constructor(private readonly deps: HubServiceDeps) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private async access(personId: string, projectId: string): Promise<Access | undefined> {
    if (!SHARED_PROJECT_ID.test(projectId)) return undefined;
    const project = await this.deps.store.getProject(projectId);
    if (!project) return undefined;
    const store = this.deps.store.project(projectId);
    const members = await store.members();
    const member = members.find((entry) => entry.personId === personId);
    return member ? { project, store, member, members } : undefined;
  }

  async create(person: Person, input: { name: unknown; origin?: { instanceId?: string | undefined; projectId: string } | undefined }): Promise<HubOutcome<ProjectView>> {
    const problem = sharedProjectProblem(input);
    if (problem) return wrong(problem);
    const project: SharedProject = {
      id: randomBytes(12).toString('hex'),
      name: (input.name as string).trim(),
      createdAt: this.now(),
      createdBy: person.id,
      ...(input.origin ? { origin: input.origin } : {}),
    };
    await this.deps.store.saveProject(project);
    await this.deps.store.project(project.id).saveMember({ personId: person.id, email: person.email, role: 'owner', joinedAt: this.now() });
    await this.deps.store.addMembership(person.id, project.id);
    return this.view(person.id, project.id);
  }

  async mine(personId: string): Promise<{ project: SharedProject; role: HubRole }[]> {
    const found: { project: SharedProject; role: HubRole }[] = [];
    for (const id of await this.deps.store.projectsOf(personId)) {
      const access = await this.access(personId, id);
      if (access) found.push({ project: access.project, role: access.member.role });
    }
    return found.sort((a, b) => a.project.name.localeCompare(b.project.name));
  }

  async view(personId: string, projectId: string): Promise<HubOutcome<ProjectView>> {
    const access = await this.access(personId, projectId);
    if (!access) return NOT_FOUND;
    const role = access.member.role;
    const invites = can(role, 'invite') ? (await access.store.invites()).map(({ token: _token, ...rest }) => rest) : undefined;
    return {
      ok: true,
      value: {
        project: access.project,
        role,
        can: ACTIONS.filter((action) => can(role, action)),
        ...(can(role, 'see-people') ? { members: access.members.sort((a, b) => a.email.localeCompare(b.email)) } : {}),
        ...(invites ? { invites } : {}),
      },
    };
  }

  async invite(person: Person, projectId: string, input: { email: unknown; role: unknown }): Promise<HubOutcome<{ email: string; role: HubRole; link: string; emailed: boolean; why?: string | undefined }>> {
    const access = await this.access(person.id, projectId);
    if (!access) return NOT_FOUND;
    if (!can(access.member.role, 'invite')) return refuse('Only an owner can invite people to this project.');
    const pending = await access.store.invites();
    const problem = inviteProblem(input, access.members, pending);
    if (problem) return wrong(problem);
    const invite: HubInvite = {
      token: randomBytes(24).toString('base64url'),
      projectId,
      email: (input.email as string).trim().toLowerCase(),
      role: input.role as HubRole,
      invitedBy: person.id,
      createdAt: this.now(),
    };
    await access.store.saveInvite(invite);
    await this.deps.store.indexInvite(invite.token, projectId);
    const sent = await this.deps.invites.send({ email: invite.email, inviterId: person.id, inviterEmail: person.email, projectName: access.project.name, role: invite.role, join: invite.token });
    return { ok: true, value: { email: invite.email, role: invite.role, ...sent } };
  }

  async takeBack(personId: string, projectId: string, email: string): Promise<HubOutcome<{ email: string }>> {
    const access = await this.access(personId, projectId);
    if (!access) return NOT_FOUND;
    if (!can(access.member.role, 'invite')) return refuse('Only an owner can take an invite back.');
    const invite = (await access.store.invites()).find((entry) => sameEmail(entry.email, email));
    if (!invite) return { ok: false, status: 404, why: `${email} is not invited.` };
    await access.store.deleteInvite(invite.token);
    await this.deps.store.forgetInvite(invite.token);
    return { ok: true, value: { email: invite.email } };
  }

  async invitation(person: Person, token: string): Promise<HubOutcome<{ projectName: string; role: HubRole; email: string; forYou: boolean }>> {
    const found = await this.invited(token);
    if (!found) return { ok: false, status: 404, why: 'This invite does not exist any more; ask for a new one.' };
    return { ok: true, value: { projectName: found.project.name, role: found.invite.role, email: found.invite.email, forYou: sameEmail(found.invite.email, person.email) } };
  }

  private async invited(token: string): Promise<{ project: SharedProject; invite: HubInvite } | undefined> {
    if (!INVITE_TOKEN.test(token)) return undefined;
    const projectId = await this.deps.store.projectOfInvite(token);
    const project = projectId ? await this.deps.store.getProject(projectId) : undefined;
    const invite = project ? (await this.deps.store.project(project.id).invites()).find((entry) => entry.token === token) : undefined;
    return project && invite ? { project, invite } : undefined;
  }

  async accept(person: Person, token: string): Promise<HubOutcome<ProjectView>> {
    const found = await this.invited(token);
    if (!found) return { ok: false, status: 404, why: 'This invite does not exist any more; ask for a new one.' };
    if (!sameEmail(found.invite.email, person.email)) return refuse(`This invite is for ${found.invite.email}; sign in as that address to take it.`);
    const store = this.deps.store.project(found.project.id);
    const already = (await store.members()).find((entry) => entry.personId === person.id);
    if (!already) await store.saveMember({ personId: person.id, email: person.email, role: found.invite.role, joinedAt: this.now(), invitedBy: found.invite.invitedBy });
    await store.deleteInvite(token);
    await this.deps.store.forgetInvite(token);
    await this.deps.store.addMembership(person.id, found.project.id);
    return this.view(person.id, found.project.id);
  }

  async changeRole(personId: string, projectId: string, memberId: string, role: unknown): Promise<HubOutcome<ProjectView>> {
    const access = await this.access(personId, projectId);
    if (!access) return NOT_FOUND;
    if (!can(access.member.role, 'change-roles')) return refuse('Only an owner can change what people may do.');
    const problem = roleChangeProblem(access.members, memberId, role);
    if (problem) return wrong(problem);
    const member = access.members.find((entry) => entry.personId === memberId)!;
    await access.store.saveMember({ ...member, role: role as HubRole });
    return this.view(personId, projectId);
  }

  async remove(personId: string, projectId: string, memberId: string): Promise<HubOutcome<{ removed: string }>> {
    const access = await this.access(personId, projectId);
    if (!access) return NOT_FOUND;
    if (memberId !== personId && !can(access.member.role, 'remove-people')) return refuse('Only an owner can remove people.');
    const problem = leavingProblem(access.members, memberId);
    if (problem) return wrong(memberId === personId ? problem : problem.replace('the last owner cannot leave', 'the last owner cannot be removed'));
    await access.store.deleteMember(memberId);
    await this.deps.store.removeMembership(memberId, projectId);
    return { ok: true, value: { removed: memberId } };
  }
}
