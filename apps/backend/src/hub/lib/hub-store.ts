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
