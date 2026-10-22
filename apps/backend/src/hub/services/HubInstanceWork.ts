import type { Readable } from 'node:stream';
import { inScope, scopeOf, type HubLink, type ShareScope, type SyncedDoc } from '../lib/hub-sync.js';
import { relayProblem, RELAY_OPS, type HubRequest, type HubStatus, type Plain, type RelayOp } from '../lib/hub-board.js';
import { forClients, seenByClients, type ClientMark } from '../lib/client-files.js';
import { cleanPath, type FileEntry } from '../../files/lib/file-places.js';
import { treeOfGroveRun } from '../../engine-host/temporal/contracts.js';
import type { HubRole } from '../lib/hub.js';
import type { Database, ProjectMetadata } from '../../platform/index.js';
import type { FileScope, FilesOutcome } from '../../files/services/FileService.js';

export type Done = { ok: true } | { ok: false; why: string };

export interface InstanceCall {
  id: string;
  op: RelayOp;
  args: Plain;
  as: { personId: string; email: string; role: HubRole };
  upload?: { type: string; size?: number | undefined; open(): Promise<Readable> } | undefined;
}

export type InstanceAnswer =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'stream'; status: number; type: string; name?: string | undefined; size?: number | undefined; stream: Readable };

type Marked = FileEntry & { forClients?: ClientMark };

export interface InstanceFiles {
  list(ownerId: string, scope: FileScope, dir: string): Promise<FilesOutcome<Marked[]>>;
  search(ownerId: string, scope: FileScope, query: string): Promise<FilesOutcome<Marked[]>>;
  clientFiles(scope: FileScope): Promise<string[]>;
  forClients(scope: FileScope, path: string, on: boolean): Promise<FilesOutcome<{ clientFiles: string[] }>>;
  download(ownerId: string, scope: FileScope, path: string): Promise<FilesOutcome<{ stream: Readable; contentType: string; size?: number | undefined }>>;
  upload(ownerId: string, scope: FileScope, path: string, body: Readable, size: number | undefined, contentType: string): Promise<FilesOutcome<{ path: string }>>;
  makeFolder(ownerId: string, scope: FileScope, path: string): Promise<FilesOutcome<{ path: string }>>;
  move(ownerId: string, scope: FileScope, from: string, to: string): Promise<FilesOutcome<{ path: string }>>;
  remove(ownerId: string, scope: FileScope, path: string): Promise<FilesOutcome<{ path: string }>>;
}

type Store = Pick<Database, 'projects' | 'engine'>;

export interface HubInstanceWorkDeps {
  store: Store;
  status(ownerId: string, project: ProjectMetadata, treeIds: readonly string[]): Promise<HubStatus>;
  act: {
    approvePlan(ownerId: string, proposalId: string): Promise<Done>;
    rejectPlan(ownerId: string, proposalId: string, reason: string | undefined): Promise<Done>;
    orderStories(ownerId: string, branchId: string, leafIds: string[]): Promise<Done>;
    orderFeatures(ownerId: string, treeId: string, branchIds: string[]): Promise<Done>;
    decideTask(ownerId: string, taskId: string, status: 'accepted' | 'dropped'): Promise<Done>;
    askKoala(ownerId: string, conversation: SyncedDoc, note: { at: string; content: string }): Promise<Done>;
    openChat(ownerId: string, item: { kind: 'story'; leafId: string } | { kind: 'feature'; branchId: string }): Promise<Done>;
  };
  live: {
    turns(ownerId: string, turnId: string, after: number, under: string | undefined): Promise<unknown>;
    procedure(ownerId: string, id: string): Promise<unknown | undefined>;
    extensions(ownerId: string): Promise<unknown>;
  };
  files: InstanceFiles;
}

const json = (status: number, body: unknown): InstanceAnswer => ({ kind: 'json', status, body });
const refused = (status: number, why: string): InstanceAnswer => json(status, { error: why });
const fromFiles = <T>(outcome: FilesOutcome<T>, shape: (value: T) => unknown = (value) => value): InstanceAnswer =>
  outcome.ok ? json(200, shape(outcome.value)) : refused(outcome.status, outcome.why);

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export class HubInstanceWork {
  constructor(private readonly deps: HubInstanceWorkDeps) {}

  private async project(link: HubLink): Promise<ProjectMetadata | undefined> {
    return (await this.deps.store.projects.getProjects()).find((entry) => entry.id === link.projectId && entry.ownerId === link.ownerId);
  }

  async scope(link: HubLink): Promise<ShareScope & { tasks: SyncedDoc[]; proposals: SyncedDoc[]; conversations: SyncedDoc[]; branches: SyncedDoc[]; leaves: SyncedDoc[] }> {
    const [trees, branches, leaves, conversations] = await Promise.all([
      this.deps.store.projects.getTrees(), this.deps.store.projects.getBranches(), this.deps.store.projects.getLeaves(), this.deps.store.engine.getConversations(),
    ]);
    const mine = <T extends { ownerId?: string | undefined }>(list: T[]) => list.filter((entry) => entry.ownerId === link.ownerId) as unknown as SyncedDoc[];
    const world = { trees: mine(trees), branches: mine(branches), leaves: mine(leaves), conversations: mine(conversations) };
    const scope = scopeOf(link.projectId, world);
    const tasks = (await this.deps.store.projects.getTasks(link.ownerId) as unknown as SyncedDoc[]).filter((task) => inScope('tasks', task, scope));
    const proposals = (await this.deps.store.projects.getPlanProposals(link.ownerId) as unknown as SyncedDoc[]).filter((proposal) => inScope('planProposals', proposal, scope));
    return {
      ...scope,
      tasks,
      proposals,
      conversations: world.conversations.filter((doc) => scope.conversationIds.has(doc.id)),
      branches: world.branches.filter((doc) => scope.branchIds.has(doc.id)),
      leaves: world.leaves.filter((doc) => scope.leafIds.has(doc.id)),
    };
  }

  async statusOf(link: HubLink): Promise<HubStatus | undefined> {
    const project = await this.project(link);
    if (!project) return undefined;
    const scope = await this.scope(link);
    return this.deps.status(link.ownerId, project, [...scope.treeIds]);
  }

  async carryOut(link: HubLink, request: HubRequest): Promise<Done> {
    const scope = await this.scope(link);
    const has = (list: readonly SyncedDoc[], id: unknown) => typeof id === 'string' && list.some((doc) => doc.id === id);
    const outside = { ok: false as const, why: 'That is not part of the shared project on the owner\'s instance.' };
    const { input } = request;
    switch (request.kind) {
      case 'approve-plan':
        return has(scope.proposals, input.proposalId) ? this.deps.act.approvePlan(link.ownerId, str(input.proposalId)) : outside;
      case 'reject-plan':
        return has(scope.proposals, input.proposalId) ? this.deps.act.rejectPlan(link.ownerId, str(input.proposalId), typeof input.reason === 'string' ? input.reason : undefined) : outside;
      case 'order-stories': {
        const leafIds = Array.isArray(input.leafIds) ? input.leafIds.map(String) : [];
        if (!scope.branchIds.has(str(input.branchId)) || !leafIds.every((id) => scope.leafIds.has(id))) return outside;
        return this.deps.act.orderStories(link.ownerId, str(input.branchId), leafIds);
      }
      case 'order-features': {
        const branchIds = Array.isArray(input.branchIds) ? input.branchIds.map(String) : [];
        if (!scope.treeIds.has(str(input.treeId)) || !branchIds.every((id) => scope.branchIds.has(id))) return outside;
        return this.deps.act.orderFeatures(link.ownerId, str(input.treeId), branchIds);
      }
      case 'accept-task':
      case 'drop-task':
        return has(scope.tasks, input.taskId) ? this.deps.act.decideTask(link.ownerId, str(input.taskId), request.kind === 'accept-task' ? 'accepted' : 'dropped') : outside;
      case 'open-chat': {
        const id = str(input.id);
        if (input.item === 'story') return scope.leafIds.has(id) ? this.deps.act.openChat(link.ownerId, { kind: 'story', leafId: id }) : outside;
        if (input.item === 'feature') return scope.branchIds.has(id) ? this.deps.act.openChat(link.ownerId, { kind: 'feature', branchId: id }) : outside;
        return outside;
      }
      case 'ask-koala': {
        const conversation = scope.conversations.find((doc) => doc.id === input.conversationId);
        if (!conversation) return outside;
        return this.deps.act.askKoala(link.ownerId, conversation, { at: str(input.at), content: str(input.content) });
      }
    }
  }

  async handle(link: HubLink, call: InstanceCall): Promise<InstanceAnswer> {
    if (!RELAY_OPS.includes(call.op)) return refused(400, `${call.op} is not something the hub may ask`);
    const problem = relayProblem(call.op, call.as.role);
    if (problem) return refused(403, problem);
    const project = await this.project(link);
    if (!project) return refused(404, 'The shared project is no longer on its owner\'s instance.');
    const owner = link.ownerId;
    if (call.op.startsWith('files.')) return this.file(link, project, call);
    const scope = await this.scope(link);
    switch (call.op) {
      case 'turns': {
        const turnId = str(call.args.turnId);
        const treeId = treeOfGroveRun(turnId);
        if (!treeId || !scope.treeIds.has(treeId)) return refused(404, 'That run is not part of this project.');
        const after = Number(call.args.after ?? 0);
        return json(200, await this.deps.live.turns(owner, turnId, Number.isInteger(after) && after >= 0 ? after : 0, typeof call.args.under === 'string' ? call.args.under : undefined));
      }
      case 'procedure': {
        const found = await this.deps.live.procedure(owner, str(call.args.id));
        return found === undefined ? refused(404, 'There is no procedure with that id') : json(200, found);
      }
      case 'extensions':
        return json(200, await this.deps.live.extensions(owner));
      default:
        return refused(400, `${call.op} is not something the hub may ask`);
    }
  }

  private async exists(ownerId: string, scope: FileScope, path: string): Promise<boolean> {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const listed = await this.deps.files.list(ownerId, scope, parent);
    return listed.ok && listed.value.some((entry) => entry.path === path);
  }

  private async file(link: HubLink, project: ProjectMetadata, call: InstanceCall): Promise<InstanceAnswer> {
    const owner = link.ownerId;
    const scope: FileScope = { kind: 'project', project };
    const shared = await this.deps.files.clientFiles(scope);
    const client = call.as.role === 'client';
    const path = (key: string, allowRoot = false) => {
      const cleaned = cleanPath(str(call.args[key]), { allowRoot });
      return cleaned.ok ? cleaned.path : undefined;
    };
    const theirs = async (at: string) => {
      if (client && !seenByClients(at, shared)) await this.deps.files.forClients(scope, at, true);
    };
    switch (call.op) {
      case 'files.list': {
        const dir = path('dir', true);
        if (dir === undefined) return refused(400, 'that is not a folder in the project');
        return fromFiles(await this.deps.files.list(owner, scope, dir), (entries) => (client ? forClients(entries, shared) : entries));
      }
      case 'files.search':
        return fromFiles(await this.deps.files.search(owner, scope, str(call.args.q)), (entries) => (client ? entries.filter((entry) => seenByClients(entry.path, shared)) : entries));
      case 'files.read': {
        const at = path('path');
        if (at === undefined) return refused(400, 'that is not a file in the project');
        if (client && !seenByClients(at, shared)) return refused(404, 'There is no such file.');
        const found = await this.deps.files.download(owner, scope, at);
        if (!found.ok) return refused(found.status, found.why);
        return { kind: 'stream', status: 200, type: found.value.contentType, name: at.split('/').pop() ?? at, ...(found.value.size !== undefined ? { size: found.value.size } : {}), stream: found.value.stream };
      }
      case 'files.upload': {
        const at = path('path');
        if (at === undefined || !call.upload) return refused(400, 'say where the file goes, and send it');
        if (client && !seenByClients(at, shared) && await this.exists(owner, scope, at)) return refused(409, 'A file you cannot see already has that name; choose another.');
        const body = await call.upload.open();
        const stored = await this.deps.files.upload(owner, scope, at, body, call.upload.size, call.upload.type);
        if (stored.ok) await theirs(at);
        return fromFiles(stored);
      }
      case 'files.folder': {
        const at = path('path');
        if (at === undefined) return refused(400, 'that is not a folder name');
        const made = await this.deps.files.makeFolder(owner, scope, at);
        if (made.ok) await theirs(at);
        return fromFiles(made);
      }
      case 'files.move': {
        const from = path('from');
        const to = path('to');
        if (from === undefined || to === undefined) return refused(400, 'say what moves and where to');
        return fromFiles(await this.deps.files.move(owner, scope, from, to));
      }
      case 'files.remove': {
        const at = path('path');
        if (at === undefined) return refused(400, 'that is not a file in the project');
        return fromFiles(await this.deps.files.remove(owner, scope, at));
      }
      case 'files.for-clients': {
        const at = path('path', true);
        if (at === undefined) return refused(400, 'that is not a file or folder in the project');
        return fromFiles(await this.deps.files.forClients(scope, at, call.args.on === true));
      }
      default:
        return refused(400, `${call.op} is not something the hub may ask`);
    }
  }
}
