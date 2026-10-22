import type { HubInvite, HubMember, SharedProject } from './hub.js';
import type { HubChange, SyncedDoc, SyncedKind } from './hub-sync.js';
import type { HubRequest, HubStatus } from './hub-board.js';

export interface SharedProjectStore {
  members(): Promise<HubMember[]>;
  saveMember(member: HubMember): Promise<void>;
  deleteMember(personId: string): Promise<void>;
  invites(): Promise<HubInvite[]>;
  saveInvite(invite: HubInvite): Promise<void>;
  deleteInvite(token: string): Promise<void>;
  records(kind: SyncedKind): Promise<SyncedDoc[]>;
  record(kind: SyncedKind, id: string): Promise<SyncedDoc | undefined>;
  putRecord(kind: SyncedKind, doc: SyncedDoc): Promise<void>;
  deleteRecord(kind: SyncedKind, id: string): Promise<void>;
  logChange(entry: Omit<HubChange, 'seq'>): Promise<HubChange>;
  changes(after: number, limit: number): Promise<HubChange[]>;
  requests(): Promise<HubRequest[]>;
  saveRequest(request: HubRequest): Promise<void>;
  status(): Promise<HubStatus | undefined>;
  putStatus(status: HubStatus): Promise<void>;
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
  project(id: string): SharedProjectStore;
}

export function memoryHubStore(): HubStore {
  const projects = new Map<string, SharedProject>();
  const memberships = new Map<string, Set<string>>();
  const inviteIndex = new Map<string, string>();
  const parts = new Map<string, { members: Map<string, HubMember>; invites: Map<string, HubInvite>; records: Map<string, SyncedDoc>; log: HubChange[]; requests: Map<string, HubRequest>; status?: HubStatus | undefined }>();
  const partOf = (id: string) => {
    let part = parts.get(id);
    if (!part) { part = { members: new Map(), invites: new Map(), records: new Map(), log: [], requests: new Map() }; parts.set(id, part); }
    return part;
  };
  const copy = (doc: SyncedDoc): SyncedDoc => JSON.parse(JSON.stringify(doc)) as SyncedDoc;
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
    project(id) {
      return {
        async members() { return [...partOf(id).members.values()].map((member) => ({ ...member })); },
        async saveMember(member) { partOf(id).members.set(member.personId, { ...member }); },
        async deleteMember(personId) { partOf(id).members.delete(personId); },
        async invites() { return [...partOf(id).invites.values()].map((invite) => ({ ...invite })); },
        async saveInvite(invite) { partOf(id).invites.set(invite.token, { ...invite }); },
        async deleteInvite(token) { partOf(id).invites.delete(token); },
        async records(kind) { return [...partOf(id).records.entries()].filter(([key]) => key.startsWith(`${kind}/`)).map(([, doc]) => copy(doc)); },
        async record(kind, recordId) { const found = partOf(id).records.get(`${kind}/${recordId}`); return found ? copy(found) : undefined; },
        async putRecord(kind, doc) { partOf(id).records.set(`${kind}/${doc.id}`, copy(doc)); },
        async deleteRecord(kind, recordId) { partOf(id).records.delete(`${kind}/${recordId}`); },
        async logChange(entry) { const log = partOf(id).log; const change = { ...JSON.parse(JSON.stringify(entry)), seq: log.length + 1 } as HubChange; log.push(change); return change; },
        async changes(after, limit) { return partOf(id).log.filter((entry) => entry.seq > after).slice(0, limit).map((entry) => JSON.parse(JSON.stringify(entry)) as HubChange); },
        async requests() { return [...partOf(id).requests.values()].map((request) => JSON.parse(JSON.stringify(request)) as HubRequest).sort((a, b) => a.at.localeCompare(b.at)); },
        async saveRequest(request) { partOf(id).requests.set(request.id, JSON.parse(JSON.stringify(request)) as HubRequest); },
        async status() { const found = partOf(id).status; return found ? JSON.parse(JSON.stringify(found)) as HubStatus : undefined; },
        async putStatus(status) { partOf(id).status = JSON.parse(JSON.stringify(status)) as HubStatus; },
        async drop() { parts.delete(id); },
      };
    },
  };
}
