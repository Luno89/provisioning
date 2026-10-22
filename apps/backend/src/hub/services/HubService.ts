import { randomBytes } from 'node:crypto';
import {
  can, inviteProblem, INVITE_TOKEN, leavingAll, leavingProblem, roleChangeProblem, sameEmail, SHARED_PROJECT_ID, sharedProjectProblem,
  type HubAction, type HubInvite, type HubMember, type HubRole, type SharedProject,
} from '../lib/hub.js';
import type { HubStore, SharedProjectStore } from '../lib/hub-store.js';
import type { HubRepoAccess, HubRepos } from './HubRepos.js';
import { applyPatch, isSyncedKind, SYNCED_KINDS, type HubChange, type RecordChange, type SyncedDoc, type SyncedKind } from '../lib/hub-sync.js';
import {
  isRequestKind, koalaAnswersOnOwners, recordFor, relayProblem, requestInput, requestProblem, statusFor,
  type HubBoard, type HubRequest, type HubRequestKind, type HubStatus, type Plain, type RelayOp,
} from '../lib/hub-board.js';
import { mentionsKoala, personMessage, withAuthorNames, type ConversationMessage } from '../../engine/lib/conversations.js';
import { InstanceOffline, type HubRelay, type RelayAnswer, type RelayCall } from './HubRelay.js';

export type SyncOrigin = { kind: 'instance'; personId: string; instanceId: string; email?: string | undefined } | { kind: 'person'; personId: string };

export const originName = (origin: SyncOrigin): string => (origin.kind === 'instance' ? `instance:${origin.instanceId}` : `person:${origin.personId}`);

export const CHANGES_PAGE = 500;

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
  repos?: HubRepos | undefined;
  relay?: HubRelay | undefined;
  now?: (() => string) | undefined;
}

export interface ChatSummary {
  id: string;
  title: string;
  kind?: 'channel' | 'item' | undefined;
  leafId?: string | undefined;
  branchId?: string | undefined;
}

export interface BoardView {
  project: SharedProject;
  role: HubRole;
  can: HubAction[];
  online: boolean;
  members: { personId: string; email: string; role: HubRole }[];
  board: HubBoard;
  chats: ChatSummary[];
  requests: HubRequest[];
}

export interface Posted {
  message: ConversationMessage;
  asked?: HubRequest | undefined;
  notAsked?: string | undefined;
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
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: HubServiceDeps) {}

  private inOrder<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const before = this.queues.get(projectId) ?? Promise.resolve();
    const next = before.then(work, work);
    this.queues.set(projectId, next.catch(() => undefined));
    return next;
  }

  private async fromOwnerInstance(origin: SyncOrigin, projectId: string): Promise<HubOutcome<Access>> {
    const access = await this.access(origin.personId, projectId);
    if (!access) return NOT_FOUND;
    if (origin.kind !== 'instance') return refuse('Only the owner\'s instance syncs a project.');
    if (access.member.role !== 'owner') return refuse('Only an owner\'s instance syncs a project.');
    if (access.project.createdBy !== origin.personId || access.project.origin?.instanceId !== origin.instanceId) return refuse('This project is worked on another instance.');
    return { ok: true, value: access };
  }

  async receive(origin: SyncOrigin, projectId: string, changes: unknown): Promise<HubOutcome<{ through: number }>> {
    const allowed = await this.fromOwnerInstance(origin, projectId);
    if (!allowed.ok) return allowed;
    if (!Array.isArray(changes) || changes.some((entry) => !entry || !isSyncedKind((entry as RecordChange).kind) || typeof (entry as RecordChange).id !== 'string' || !(entry as RecordChange).id)) {
      return wrong('each change names a kind of record, its id, and a patch or that it was deleted');
    }
    return this.record(allowed.value, originName(origin), changes as RecordChange[]);
  }

  private record(access: Access, origin: string, changes: readonly RecordChange[]): Promise<HubOutcome<{ through: number }>> {
    return this.inOrder(access.project.id, async () => {
      let through = 0;
      for (const change of changes) {
        if ('deleted' in change) await access.store.deleteRecord(change.kind, change.id);
        else await access.store.putRecord(change.kind, applyPatch(await access.store.record(change.kind, change.id), change.id, change.patch));
        through = (await access.store.logChange({ origin, change, at: this.now() })).seq;
      }
      return { ok: true as const, value: { through } };
    });
  }

  async changesSince(origin: SyncOrigin, projectId: string, after: number): Promise<HubOutcome<{ changes: HubChange[]; through: number; members: { personId: string; email: string; role: HubRole }[] }>> {
    const allowed = await this.fromOwnerInstance(origin, projectId);
    if (!allowed.ok) return allowed;
    const changes = await allowed.value.store.changes(Number.isFinite(after) && after > 0 ? after : 0, CHANGES_PAGE);
    return { ok: true, value: { changes, through: changes.at(-1)?.seq ?? after, members: allowed.value.members.map(({ personId, email, role }) => ({ personId, email, role })) } };
  }

  async waitingRequests(origin: SyncOrigin, projectId: string): Promise<HubOutcome<HubRequest[]>> {
    const allowed = await this.fromOwnerInstance(origin, projectId);
    if (!allowed.ok) return allowed;
    return { ok: true, value: (await allowed.value.store.requests()).filter((request) => request.state === 'waiting') };
  }

  async settleRequest(origin: SyncOrigin, projectId: string, requestId: string, outcome: { state: unknown; why?: unknown }): Promise<HubOutcome<HubRequest>> {
    const allowed = await this.fromOwnerInstance(origin, projectId);
    if (!allowed.ok) return allowed;
    if (outcome.state !== 'done' && outcome.state !== 'refused') return wrong('a request is settled as done or refused');
    const request = (await allowed.value.store.requests()).find((entry) => entry.id === requestId);
    if (!request) return { ok: false, status: 404, why: 'There is no such request.' };
    const settled: HubRequest = { ...request, state: outcome.state, ...(typeof outcome.why === 'string' && outcome.why ? { why: outcome.why } : {}), settledAt: this.now() };
    await allowed.value.store.saveRequest(settled);
    return { ok: true, value: settled };
  }

  async putStatus(origin: SyncOrigin, projectId: string, status: unknown): Promise<HubOutcome<{ at: string }>> {
    const allowed = await this.fromOwnerInstance(origin, projectId);
    if (!allowed.ok) return allowed;
    const given = status as Partial<HubStatus> | undefined;
    if (!given || !Array.isArray(given.releases) || !Array.isArray(given.runs) || !given.treeRuns || typeof given.treeRuns !== 'object') return wrong('a status carries the releases, builds and tree runs');
    const kept: HubStatus = { at: this.now(), releases: given.releases, runs: given.runs, treeRuns: given.treeRuns, ...(given.addresses ? { addresses: given.addresses } : {}) };
    await allowed.value.store.putStatus(kept);
    return { ok: true, value: { at: kept.at } };
  }

  async takeRelay(origin: SyncOrigin, projectId: string, closed: Promise<void>): Promise<HubOutcome<RelayCall | undefined>> {
    const allowed = await this.fromOwnerInstance(origin, projectId);
    if (!allowed.ok) return allowed;
    if (!this.deps.relay) return { ok: false, status: 404, why: 'This hub relays nothing.' };
    return { ok: true, value: await this.deps.relay.take(projectId, closed) };
  }

  async relayed(origin: SyncOrigin, callId: string): Promise<HubOutcome<RelayCall>> {
    const call = this.deps.relay?.callOf(callId);
    if (!call) return { ok: false, status: 404, why: 'That call is no longer waiting.' };
    const allowed = await this.fromOwnerInstance(origin, call.projectId);
    if (!allowed.ok) return allowed;
    return { ok: true, value: call };
  }

  async answerRelay(origin: SyncOrigin, callId: string, answer: RelayAnswer): Promise<HubOutcome<{ answered: string }>> {
    const call = await this.relayed(origin, callId);
    if (!call.ok) return call;
    this.deps.relay!.answer(callId, answer);
    return { ok: true, value: { answered: callId } };
  }

  async boardView(personId: string, projectId: string): Promise<HubOutcome<BoardView>> {
    const access = await this.access(personId, projectId);
    if (!access) return NOT_FOUND;
    const role = access.member.role;
    const read = async (kind: SyncedKind) => (await access.store.records(kind)).map((doc) => recordFor(role, kind, doc));
    const [trees, branches, leaves, tasks, planProposals, conversations] = await Promise.all((['trees', 'branches', 'leaves', 'tasks', 'planProposals', 'conversations'] as const).map(read));
    const status = statusFor(role, await access.store.status());
    const requests = (await access.store.requests()).filter((request) => request.state === 'waiting' || request.by.personId === personId);
    return {
      ok: true,
      value: {
        project: access.project,
        role,
        can: ACTIONS.filter((action) => can(role, action)),
        online: this.deps.relay?.online(projectId) ?? false,
        members: access.members.map(({ personId: id, email, role: theirs }) => ({ personId: id, email, role: theirs })),
        board: { trees: trees!, branches: branches!, leaves: leaves!, tasks: tasks!, planProposals: planProposals!, ...(status ? { status } : {}) },
        chats: conversations!.map((doc) => ({ id: doc.id, title: String(doc.title ?? ''), ...(doc.kind ? { kind: doc.kind as 'channel' | 'item' } : {}), ...(doc.leafId ? { leafId: String(doc.leafId) } : {}), ...(doc.branchId ? { branchId: String(doc.branchId) } : {}) })),
        requests,
      },
    };
  }

  async conversation(personId: string, projectId: string, conversationId: string): Promise<HubOutcome<SyncedDoc>> {
    const access = await this.access(personId, projectId);
    if (!access) return NOT_FOUND;
    const doc = await access.store.record('conversations', conversationId);
    if (!doc) return { ok: false, status: 404, why: 'There is no such chat on this project.' };
    const shown = recordFor(access.member.role, 'conversations', doc) as SyncedDoc & { messages: ConversationMessage[] };
    return { ok: true, value: withAuthorNames({ ...shown, messages: shown.messages ?? [] }, personId, new Map(access.members.map((member) => [member.personId, member.email]))) };
  }

  async post(person: Person, projectId: string, conversationId: string, input: { content: unknown; askKoala?: unknown }): Promise<HubOutcome<Posted>> {
    const access = await this.access(person.id, projectId);
    if (!access) return NOT_FOUND;
    if (!can(access.member.role, 'pin-and-comment')) return refuse('You cannot post on this project.');
    const chat = await access.store.record('conversations', conversationId);
    if (!chat) return { ok: false, status: 404, why: 'There is no such chat on this project.' };
    const message = personMessage(person.id, String(input.content ?? ''), this.now());
    if ('problem' in message) return wrong(message.problem);
    const recorded = await this.record(access, `person:${person.id}`, [{ kind: 'conversations', id: conversationId, patch: { messages: { put: [message] } } }]);
    if (!recorded.ok) return recorded;
    const wantsKoala = chat.kind === 'item' || input.askKoala === true || mentionsKoala(message.content);
    if (!wantsKoala) return { ok: true, value: { message } };
    if (!koalaAnswersOnOwners(access.member.role)) return { ok: true, value: { message, notAsked: 'Koala answers a collaborator from their own instance, once it is linked to this project; your message is posted.' } };
    const asked = await this.saveRequest(access, person, 'ask-koala', { conversationId, at: message.at, content: message.content }, recorded.value.through);
    return { ok: true, value: { message, asked } };
  }

  async request(person: Person, projectId: string, body: Plain): Promise<HubOutcome<HubRequest>> {
    const access = await this.access(person.id, projectId);
    if (!access) return NOT_FOUND;
    const all = Object.fromEntries(await Promise.all(SYNCED_KINDS.map(async (kind) => [kind, await access.store.records(kind)] as const))) as Record<SyncedKind, SyncedDoc[]>;
    const input = isRequestKind(body.kind) ? requestInput(body.kind, body) : {};
    const problem = requestProblem(body.kind, input, access.member.role, all);
    if (problem) return { ok: false, status: problem.status, why: problem.why };
    const same = (await access.store.requests()).find((entry) => entry.state === 'waiting' && entry.kind === body.kind && JSON.stringify(entry.input) === JSON.stringify(input));
    if (same) return { ok: true, value: same };
    return { ok: true, value: await this.saveRequest(access, person, body.kind as HubRequestKind, input, 0) };
  }

  private async saveRequest(access: Access, person: Person, kind: HubRequestKind, input: Plain, after: number): Promise<HubRequest> {
    const request: HubRequest = { id: randomBytes(12).toString('hex'), kind, input, by: { personId: person.id, email: person.email, role: access.member.role }, at: this.now(), after, state: 'waiting' };
    await access.store.saveRequest(request);
    return request;
  }

  async repository(personId: string, projectId: string): Promise<HubOutcome<{ files: string[] }>> {
    const access = await this.access(personId, projectId);
    if (!access) return NOT_FOUND;
    if (!can(access.member.role, 'see-code')) return refuse('Only an owner or a collaborator sees the code.');
    if (!this.deps.repos) return { ok: false, status: 404, why: 'This hub keeps no repositories.' };
    return { ok: true, value: { files: (await this.deps.repos.files(projectId)).sort() } };
  }

  async repositoryFile(personId: string, projectId: string, path: string): Promise<HubOutcome<{ path: string; content: string }>> {
    const access = await this.access(personId, projectId);
    if (!access) return NOT_FOUND;
    if (!can(access.member.role, 'see-code')) return refuse('Only an owner or a collaborator sees the code.');
    if (!this.deps.repos) return { ok: false, status: 404, why: 'This hub keeps no repositories.' };
    const content = await this.deps.repos.read(projectId, path);
    return content === null ? { ok: false, status: 404, why: `There is no ${path} on main.` } : { ok: true, value: { path, content } };
  }

  async relay(person: Person, projectId: string, op: RelayOp, args: Plain, upload?: RelayCall['upload']): Promise<HubOutcome<RelayAnswer>> {
    const access = await this.access(person.id, projectId);
    if (!access) return NOT_FOUND;
    const problem = relayProblem(op, access.member.role);
    if (problem) return refuse(problem);
    if (!this.deps.relay) return { ok: false, status: 409, why: 'This hub cannot reach the owner\'s instance.' };
    try {
      return { ok: true, value: await this.deps.relay.call(projectId, op, args, { personId: person.id, email: person.email, role: access.member.role }, upload) };
    } catch (err) {
      if (err instanceof InstanceOffline) return { ok: false, status: 409, why: err.message };
      throw err;
    }
  }

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
    if (input.origin) {
      const already = (await this.mine(person.id)).find((entry) => entry.project.origin?.projectId === input.origin!.projectId && entry.project.origin?.instanceId === input.origin!.instanceId);
      if (already) return this.view(person.id, already.project.id);
    }
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

  async delete(personId: string, projectId: string, typedName: unknown): Promise<HubOutcome<{ deleted: string }>> {
    const access = await this.access(personId, projectId);
    if (!access) return NOT_FOUND;
    if (!can(access.member.role, 'change-settings')) return refuse('Only an owner can delete this project.');
    if (typeof typedName !== 'string' || typedName.trim() !== access.project.name) return wrong(`type the project's name, ${access.project.name}, to delete it`);
    await this.dropProject(access);
    return { ok: true, value: { deleted: projectId } };
  }

  async share(origin: SyncOrigin, input: { name: unknown; projectId: unknown }): Promise<HubOutcome<{ view: ProjectView; repo?: HubRepoAccess | undefined }>> {
    if (origin.kind !== 'instance') return refuse('A project is shared from the instance it is worked on.');
    if (typeof input.projectId !== 'string' || !input.projectId) return wrong('name the project being shared');
    if (!origin.email) return wrong('the instance did not say whose project this is');
    const made = await this.create({ id: origin.personId, email: origin.email }, { name: input.name, origin: { instanceId: origin.instanceId, projectId: input.projectId } });
    if (!made.ok) return made;
    const repo = this.deps.repos ? await this.deps.repos.create(made.value.project.id) : undefined;
    return { ok: true, value: { view: made.value, ...(repo ? { repo } : {}) } };
  }

  async unshare(origin: SyncOrigin, projectId: string): Promise<HubOutcome<{ deleted: string }>> {
    const allowed = await this.fromOwnerInstance(origin, projectId);
    if (!allowed.ok) return allowed;
    await this.dropProject(allowed.value);
    return { ok: true, value: { deleted: projectId } };
  }

  private async dropProject(access: Access): Promise<void> {
    if (this.deps.repos) await this.deps.repos.remove(access.project.id);
    for (const invite of await access.store.invites()) await this.deps.store.forgetInvite(invite.token);
    for (const member of access.members) await this.deps.store.removeMembership(member.personId, access.project.id);
    await this.deps.store.deleteProject(access.project.id);
    await access.store.drop();
  }

  private async everywhere(personId: string): Promise<{ access: Access; leaving: ReturnType<typeof leavingAll> }[]> {
    const found = [];
    for (const id of await this.deps.store.projectsOf(personId)) {
      const access = await this.access(personId, id);
      if (access) found.push({ access, leaving: leavingAll(access.project, access.members, personId) });
      else await this.deps.store.removeMembership(personId, id);
    }
    return found;
  }

  async leaving(personId: string): Promise<{ blockers: string[]; deletes: string[]; leaves: string[] }> {
    const all = await this.everywhere(personId);
    return {
      blockers: all.flatMap(({ leaving }) => (leaving.kind === 'blocked' ? [leaving.why] : [])),
      deletes: all.filter(({ leaving }) => leaving.kind === 'delete').map(({ access }) => access.project.name),
      leaves: all.filter(({ leaving }) => leaving.kind === 'leave').map(({ access }) => access.project.name),
    };
  }

  async letGo(personId: string): Promise<{ deleted: string[]; left: string[] }> {
    const all = await this.everywhere(personId);
    const blocked = all.flatMap(({ leaving }) => (leaving.kind === 'blocked' ? [leaving.why] : []));
    if (blocked.length > 0) throw new Error(blocked.join('; '));
    const done = { deleted: [] as string[], left: [] as string[] };
    for (const { access, leaving } of all) {
      if (leaving.kind === 'delete') {
        await this.dropProject(access);
        done.deleted.push(access.project.id);
      } else {
        for (const invite of (await access.store.invites()).filter((entry) => entry.invitedBy === personId)) {
          await access.store.deleteInvite(invite.token);
          await this.deps.store.forgetInvite(invite.token);
        }
        await access.store.deleteMember(personId);
        await this.deps.store.removeMembership(personId, access.project.id);
        done.left.push(access.project.id);
      }
    }
    return done;
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
