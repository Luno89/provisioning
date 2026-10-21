import type { HubInvite, HubMember, HubPerson, SharedProject } from './hub.js';

export interface SharedProjectStore {
  members(): Promise<HubMember[]>;
  saveMember(member: HubMember): Promise<void>;
  deleteMember(personId: string): Promise<void>;
  invites(): Promise<HubInvite[]>;
  saveInvite(invite: HubInvite): Promise<void>;
  deleteInvite(token: string): Promise<void>;
  drop(): Promise<void>;
}

export interface HubStore {
  init(): Promise<void>;
  close(): Promise<void>;
  saveProject(project: SharedProject): Promise<void>;
  getProject(id: string): Promise<SharedProject | undefined>;
  deleteProject(id: string): Promise<void>;
  addMembership(personId: string, projectId: string): Promise<void>;
  removeMembership(personId: string, projectId: string): Promise<void>;
  projectsOf(personId: string): Promise<string[]>;
  indexInvite(token: string, projectId: string): Promise<void>;
  projectOfInvite(token: string): Promise<string | undefined>;
  forgetInvite(token: string): Promise<void>;
  savePerson(person: HubPerson): Promise<void>;
  getPerson(id: string): Promise<HubPerson | undefined>;
  claimHandoff(jti: string, expiresAt: string): Promise<boolean>;
  project(id: string): SharedProjectStore;
}

export function memoryHubStore(): HubStore {
  const projects = new Map<string, SharedProject>();
  const memberships = new Map<string, Set<string>>();
  const inviteIndex = new Map<string, string>();
  const people = new Map<string, HubPerson>();
  const handoffs = new Set<string>();
  const parts = new Map<string, { members: Map<string, HubMember>; invites: Map<string, HubInvite> }>();
  const partOf = (id: string) => {
    let part = parts.get(id);
    if (!part) { part = { members: new Map(), invites: new Map() }; parts.set(id, part); }
    return part;
  };
  return {
    async init() {},
    async close() {},
    async saveProject(project) { projects.set(project.id, { ...project }); },
    async getProject(id) { const found = projects.get(id); return found ? { ...found } : undefined; },
    async deleteProject(id) { projects.delete(id); },
    async addMembership(personId, projectId) { const set = memberships.get(personId) ?? new Set(); set.add(projectId); memberships.set(personId, set); },
    async removeMembership(personId, projectId) { memberships.get(personId)?.delete(projectId); },
    async projectsOf(personId) { return [...(memberships.get(personId) ?? [])].sort(); },
    async indexInvite(token, projectId) { inviteIndex.set(token, projectId); },
    async projectOfInvite(token) { return inviteIndex.get(token); },
    async forgetInvite(token) { inviteIndex.delete(token); },
    async savePerson(person) { people.set(person.id, { ...person }); },
    async getPerson(id) { const found = people.get(id); return found ? { ...found } : undefined; },
    async claimHandoff(jti) { if (handoffs.has(jti)) return false; handoffs.add(jti); return true; },
    project(id) {
      return {
        async members() { return [...partOf(id).members.values()].map((member) => ({ ...member })); },
        async saveMember(member) { partOf(id).members.set(member.personId, { ...member }); },
        async deleteMember(personId) { partOf(id).members.delete(personId); },
        async invites() { return [...partOf(id).invites.values()].map((invite) => ({ ...invite })); },
        async saveInvite(invite) { partOf(id).invites.set(invite.token, { ...invite }); },
        async deleteInvite(token) { partOf(id).invites.delete(token); },
        async drop() { parts.delete(id); },
      };
    },
  };
}
