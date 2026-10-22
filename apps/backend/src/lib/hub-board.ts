import { can, type HubRole } from './hub.js';
import type { SyncedDoc, SyncedKind } from './hub-sync.js';

export type Plain = Record<string, unknown>;

export const HUB_STATUS_BUILDS = 20;

export const RELAY_STATUS_HEADER = 'x-relay-status';
export const RELAY_TYPE_HEADER = 'x-relay-type';
export const RELAY_NAME_HEADER = 'x-relay-name';

export interface HubStatus {
  at: string;
  releases: Plain[];
  addresses?: Plain | undefined;
  runs: Plain[];
  treeRuns: Record<string, Plain>;
}

export interface HubBoard {
  trees: SyncedDoc[];
  branches: SyncedDoc[];
  leaves: SyncedDoc[];
  tasks: SyncedDoc[];
  planProposals: SyncedDoc[];
  status?: HubStatus | undefined;
}

const pick = (doc: Plain, fields: readonly string[]): Plain =>
  Object.fromEntries(fields.filter((field) => doc[field] !== undefined).map((field) => [field, doc[field]]));

const CLIENT_FIELDS: Record<Exclude<SyncedKind, 'planProposals'>, readonly string[]> = {
  trees: ['id', 'name', 'type', 'version', 'goal', 'projectIds', 'createdAt', 'updatedAt'],
  branches: ['id', 'treeId', 'title', 'priority', 'createdAt', 'updatedAt'],
  leaves: ['id', 'branchId', 'title', 'body', 'status', 'dependsOn', 'priority', 'tasks', 'verified', 'landed', 'waitingFor', 'createdAt', 'updatedAt'],
  tasks: ['id', 'leafId', 'projectId', 'title', 'intent', 'description', 'role', 'doneMeans', 'dependsOn', 'status', 'createdAt', 'updatedAt'],
  conversations: ['id', 'title', 'kind', 'treeId', 'projectId', 'leafId', 'branchId', 'liveTurn', 'messages', 'createdAt', 'updatedAt'],
};

const MESSAGE_FIELDS_FOR_CLIENTS = ['role', 'author', 'notice', 'content', 'at', 'attachments', 'runId'];

export const seesWork = (role: HubRole): boolean => can(role, 'see-code');

export function recordFor(role: HubRole, kind: SyncedKind, doc: SyncedDoc): SyncedDoc {
  const { ownerId: _ownerId, ...rest } = doc;
  if (seesWork(role)) return rest as SyncedDoc;
  if (kind === 'planProposals') return rest as SyncedDoc;
  if (kind === 'conversations') {
    const messages = ((rest.messages ?? []) as Plain[]).map((message) => pick(message, MESSAGE_FIELDS_FOR_CLIENTS));
    return { ...pick(rest, CLIENT_FIELDS.conversations), id: doc.id, messages } as SyncedDoc;
  }
  return { ...pick(rest, CLIENT_FIELDS[kind]), id: doc.id } as SyncedDoc;
}

export function statusFor(role: HubRole, status: HubStatus | undefined): HubStatus | undefined {
  if (!status || seesWork(role)) return status;
  return {
    at: status.at,
    releases: status.releases.map((release) => pick(release, ['id', 'state', 'slot', 'startedAt', 'liveAt', 'updatedAt'])),
    ...(status.addresses ? { addresses: status.addresses } : {}),
    runs: status.runs.filter((run) => run.promotedAt !== undefined).map((run) => pick(run, ['id', 'startedAt', 'promotedAt'])),
    treeRuns: {},
  };
}

export type HubRequestKind = 'approve-plan' | 'reject-plan' | 'order-stories' | 'order-features' | 'accept-task' | 'drop-task' | 'ask-koala' | 'open-chat';

export const HUB_REQUEST_KINDS: readonly HubRequestKind[] = ['approve-plan', 'reject-plan', 'order-stories', 'order-features', 'accept-task', 'drop-task', 'ask-koala', 'open-chat'];

export interface HubRequest {
  id: string;
  kind: HubRequestKind;
  input: Plain;
  by: { personId: string; email: string; role: HubRole };
  at: string;
  after: number;
  state: 'waiting' | 'done' | 'refused';
  why?: string | undefined;
  settledAt?: string | undefined;
}

export const koalaAnswersOnOwners = (role: HubRole): boolean => role === 'owner' || role === 'client';

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(text);

export type RequestProblem = { status: 400 | 403; why: string };

export const isRequestKind = (value: unknown): value is HubRequestKind => HUB_REQUEST_KINDS.includes(value as HubRequestKind);

export function requestProblem(kind: unknown, input: Plain, role: HubRole, board: Pick<HubBoard, 'branches' | 'leaves' | 'tasks' | 'planProposals' | 'trees'> & { conversations: SyncedDoc[] }): RequestProblem | undefined {
  const bad = (why: string): RequestProblem => ({ status: 400, why });
  const refused = (why: string): RequestProblem => ({ status: 403, why });
  if (!isRequestKind(kind)) return bad(`a request is one of ${HUB_REQUEST_KINDS.join(', ')}`);
  const has = (list: readonly SyncedDoc[], id: unknown) => typeof id === 'string' && list.some((doc) => doc.id === id);
  if (kind === 'open-chat') {
    if (!can(role, 'pin-and-comment')) return refused('you cannot talk on this project');
    if (input.item === 'story') return has(board.leaves, input.id) ? undefined : bad('that story is not part of this project');
    if (input.item === 'feature') return has(board.branches, input.id) ? undefined : bad('that feature is not part of this project');
    return bad('a chat is about a story or a feature');
  }
  if (kind === 'ask-koala') {
    if (!can(role, 'ask-koala')) return refused('you cannot ask Koala on this project');
    if (!koalaAnswersOnOwners(role)) return refused('Koala answers a collaborator from their own instance, once it is linked to this project');
    if (!has(board.conversations, input.conversationId)) return bad('that chat is not part of this project');
    if (!text(input.at) || typeof input.content !== 'string') return bad('name the message Koala should answer');
    return undefined;
  }
  if (!can(role, 'approve-changes')) return refused('only an owner or a collaborator can change the work');
  switch (kind) {
    case 'approve-plan':
    case 'reject-plan':
      return has(board.planProposals, input.proposalId) ? undefined : bad('that card is not part of this project');
    case 'order-stories': {
      if (!has(board.branches, input.branchId) || !ids(input.leafIds)) return bad('name the feature and its stories in their new order');
      const own = new Set(board.leaves.filter((leaf) => leaf.branchId === input.branchId).map((leaf) => leaf.id));
      return (input.leafIds as string[]).every((id) => own.has(id)) ? undefined : bad('every story must be one of that feature\'s');
    }
    case 'order-features': {
      if (!has(board.trees, input.treeId) || !ids(input.branchIds)) return bad('name the epic and its features in their new order');
      const own = new Set(board.branches.filter((branch) => branch.treeId === input.treeId).map((branch) => branch.id));
      return (input.branchIds as string[]).every((id) => own.has(id)) ? undefined : bad('every feature must be one of that epic\'s');
    }
    case 'accept-task':
    case 'drop-task':
      return has(board.tasks, input.taskId) ? undefined : bad('that task is not part of this project');
  }
}

export const requestInput = (kind: HubRequestKind, body: Plain): Plain => {
  const fields: Record<HubRequestKind, readonly string[]> = {
    'approve-plan': ['proposalId'],
    'reject-plan': ['proposalId', 'reason'],
    'order-stories': ['branchId', 'leafIds'],
    'order-features': ['treeId', 'branchIds'],
    'accept-task': ['taskId'],
    'drop-task': ['taskId'],
    'ask-koala': ['conversationId', 'at', 'content'],
    'open-chat': ['item', 'id'],
  };
  return pick(body, fields[kind]);
};

export const RELAY_OPS = ['turns', 'procedure', 'extensions', 'files.list', 'files.search', 'files.read', 'files.upload', 'files.folder', 'files.move', 'files.remove', 'files.for-clients'] as const;
export type RelayOp = typeof RELAY_OPS[number];

const WORK_OPS: ReadonlySet<RelayOp> = new Set(['turns', 'procedure', 'extensions']);
const CHANGING_FILES: ReadonlySet<RelayOp> = new Set(['files.move', 'files.remove', 'files.for-clients']);

export function relayProblem(op: RelayOp, role: HubRole): string | undefined {
  if (WORK_OPS.has(op) && !seesWork(role)) return 'only an owner or a collaborator sees how the work runs';
  if (CHANGING_FILES.has(op) && !seesWork(role)) return 'only an owner or a collaborator can move, remove or share files';
  return undefined;
}
