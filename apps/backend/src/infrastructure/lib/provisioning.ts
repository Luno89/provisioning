import {
  PROVISION_DONE_STAGE, PROVISION_DONE_TITLE, PROVISION_PIECES,
  type ProvisioningView, type ProvisionPieceKey, type ProvisionPieceView, type ProvisionReason, type ProvisionReport, type ProvisionRootRefusal, type ProvisionTarget,
} from '@koala/engine-core/koala-install';
import { boundedLine, boundedWhy, type MachineProgress } from '@koala/engine-core/machine-progress';

export interface ProvisioningRecord extends ProvisioningView {
  runId: string;
  ownerId: string;
  workflowId?: string;
}

export interface ProvisionRunInput {
  ownerId: string;
  recordId: string;
  target: ProvisionTarget;
  revision: number;
  reason: ProvisionReason;
}

export interface ProvisionPieceInput {
  ownerId: string;
  recordId: string;
  target: ProvisionTarget;
  revision: number;
  piece: ProvisionPieceKey;
}

export type ProvisionPieceResult = { ok: true } | { ok: false; why: string };

export type Provisioned = { state: 'up' } | { state: 'failed'; why: string } | { state: 'waiting'; line: string };

export interface Provisioner {
  ensure(target: ProvisionTarget, reason: Exclude<ProvisionReason, 'revision'>): Promise<ProvisioningRecord>;
  settled(recordId: string): Promise<Provisioned>;
}

export type StartDecision =
  | { start: true }
  | { start: false; running: ProvisioningRecord }
  | { start: false; already: ProvisioningRecord };

export type PieceChange =
  | { state: 'started'; line?: string | undefined }
  | { state: 'done' | 'already-done' }
  | { state: 'failed'; why: string };

export const provisionWorkflowId = (clusterId: string): string => `provision-${clusterId}`;

export const provisionRunId = (clusterId: string, stamp: string): string => `${provisionWorkflowId(clusterId)}~${stamp}`;

export const provisionPieceWorkflowId = (runId: string, piece: ProvisionPieceKey): string => `${runId}~${piece}`;

const nameOf = (target: ProvisionTarget): string => (target.kind === 'machine' ? target.machine : target.clusterId);

export function piecesFor(target: ProvisionTarget): ProvisionPieceView[] {
  if (target.kind === 'machine') return [{ key: 'monitoring', title: `${target.machine}'s collector`, state: 'waiting' }];
  return PROVISION_PIECES.map((piece) => ({ key: piece.key, title: piece.title, state: 'waiting' }));
}

export function openedRecord(given: { ownerId: string; target: ProvisionTarget; revision: number; reason: ProvisionReason; runId: string; at: string }): ProvisioningRecord {
  return {
    id: given.runId,
    runId: given.runId,
    ownerId: given.ownerId,
    target: given.target,
    revision: given.revision,
    reason: given.reason,
    state: 'running',
    pieces: piecesFor(given.target),
    startedAt: given.at,
  };
}

const ofCluster = (records: readonly ProvisioningRecord[], clusterId: string): ProvisioningRecord[] =>
  records.filter((record) => record.target.clusterId === clusterId);

export function startDecision(records: readonly ProvisioningRecord[], target: ProvisionTarget, revision: number, reason: ProvisionReason): StartDecision {
  const mine = ofCluster(records, target.clusterId);
  const running = mine.find((record) => record.state === 'running');
  if (running) return { start: false, running };
  if (reason !== 'revision') return { start: true };
  const already = latest(mine.filter((record) => record.revision === revision));
  return already ? { start: false, already } : { start: true };
}

function pieceOf(record: ProvisioningRecord, key: string): ProvisionPieceView {
  const piece = record.pieces.find((entry) => entry.key === key);
  if (!piece) throw new Error(`the setup of ${nameOf(record.target)} has no piece ${key}`);
  return piece;
}

export function pieceProgress(record: ProvisioningRecord, key: ProvisionPieceKey, change: PieceChange): MachineProgress {
  const { title } = pieceOf(record, key);
  if (change.state === 'failed') return { stage: key, title, state: 'failed', why: boundedWhy(change.why) };
  if (change.state === 'started') return { stage: key, title, state: 'started', ...(change.line ? { line: boundedLine(change.line) } : {}) };
  return { stage: key, title, state: change.state };
}

export const setUpProgress = (): MachineProgress => ({ stage: PROVISION_DONE_STAGE, title: PROVISION_DONE_TITLE, state: 'done' });

const withPiece = (record: ProvisioningRecord, piece: ProvisionPieceView): ProvisionPieceView[] =>
  record.pieces.map((entry) => (entry.key === piece.key ? piece : entry));

export function pieceHeard(record: ProvisioningRecord, progress: MachineProgress, at: string): ProvisioningRecord {
  if (progress.stage === PROVISION_DONE_STAGE) {
    const left = record.pieces.filter((piece) => piece.state !== 'up').map((piece) => piece.key);
    if (left.length > 0) throw new Error(`the setup of ${nameOf(record.target)} cannot be up while ${left.join(', ')} are not`);
    return { ...record, state: 'up', endedAt: at };
  }
  const { key, title } = pieceOf(record, progress.stage);
  if (progress.state === 'failed') {
    const why = progress.why ?? 'it gave no reason';
    return { ...record, state: 'failed', why: `${title}: ${why}`, endedAt: at, pieces: withPiece(record, { key, title, state: 'failed', why, at }) };
  }
  if (progress.state === 'started') return { ...record, pieces: withPiece(record, { key, title, state: 'working', ...(progress.line ? { line: progress.line } : {}), at }) };
  return { ...record, pieces: withPiece(record, { key, title, state: 'up', at }) };
}

export type HeardPatch = Pick<ProvisioningRecord, 'state' | 'pieces'> & Partial<Pick<ProvisioningRecord, 'why' | 'endedAt'>>;

export interface ProvisioningRecords {
  getProvisioningRun(id: string): Promise<ProvisioningRecord | undefined>;
  patchProvisioning(id: string, patch: HeardPatch, whileRunning: true): Promise<ProvisioningRecord | undefined>;
}

export type Recorded = { recorded: ProvisioningRecord } | { gone: true } | { ended: ProvisioningRecord };

export const heardPatch = (record: ProvisioningRecord): HeardPatch => ({
  state: record.state,
  pieces: record.pieces,
  ...(record.why !== undefined ? { why: record.why } : {}),
  ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
});

export async function recordedOn(records: ProvisioningRecords, recordId: string, change: (record: ProvisioningRecord) => ProvisioningRecord): Promise<Recorded> {
  const record = await records.getProvisioningRun(recordId);
  if (!record) return { gone: true };
  if (record.state !== 'running') return { ended: record };
  const written = await records.patchProvisioning(recordId, heardPatch(change(record)), true);
  if (written) return { recorded: written };
  const now = await records.getProvisioningRun(recordId);
  return now ? { ended: now } : { gone: true };
}

export function runEnded(record: ProvisioningRecord, why: string, at: string): ProvisioningRecord {
  if (record.state !== 'running') return record;
  return {
    ...record,
    state: 'failed',
    why,
    endedAt: at,
    pieces: record.pieces.map((piece) => (piece.state === 'working' ? { key: piece.key, title: piece.title, state: 'failed', why, at } : piece)),
  };
}

export function provisioningView(record: ProvisioningRecord): ProvisioningView {
  const { runId: _run, ownerId: _owner, workflowId: _workflow, ...view } = record;
  return view;
}

const HEARD_AS: Record<MachineProgress['state'], string> = { started: 'under way', done: 'up', 'already-done': 'up', failed: 'failed' };

const heardAs = (progress: MachineProgress): string =>
  (progress.stage === PROVISION_DONE_STAGE ? progress.title : `${progress.title} is ${HEARD_AS[progress.state]}`);

export function rootRefusal(progress: MachineProgress, answer: { status: number; error: string } | { thrown: string }, at: string): ProvisionRootRefusal {
  const why = 'thrown' in answer
    ? `root could not be told that ${heardAs(progress)}: ${answer.thrown}`
    : `root refused hearing that ${heardAs(progress)}: ${answer.error} (${answer.status})`;
  return { why: boundedWhy(why), at };
}

export function rootReportOf(record: ProvisioningRecord, progress: MachineProgress): ProvisionReport | undefined {
  return record.target.kind === 'koala' ? { revision: record.revision, progress } : undefined;
}

const samePiece = (a: ProvisionPieceView | undefined, b: ProvisionPieceView): boolean =>
  a !== undefined && a.state === b.state && a.line === b.line && a.why === b.why;

const changeOf = (piece: ProvisionPieceView): PieceChange | undefined => {
  if (piece.state === 'working') return { state: 'started', line: piece.line };
  if (piece.state === 'up') return { state: 'done' };
  if (piece.state === 'failed') return { state: 'failed', why: piece.why ?? 'it gave no reason' };
  return undefined;
};

export function progressSince(before: ProvisioningRecord | undefined, after: ProvisioningRecord): MachineProgress[] {
  const lines: MachineProgress[] = [];
  for (const piece of after.pieces) {
    if (samePiece(before?.pieces.find((entry) => entry.key === piece.key), piece)) continue;
    const change = changeOf(piece);
    if (change) lines.push(pieceProgress(after, piece.key, change));
  }
  const newlyEnded = after.state !== 'running' && before?.state !== after.state;
  if (newlyEnded && after.state === 'up') lines.push(setUpProgress());
  if (newlyEnded && after.state === 'failed' && !lines.some((line) => line.state === 'failed')) {
    const stopped = after.pieces.find((piece) => piece.state === 'failed') ?? after.pieces.find((piece) => piece.state !== 'up') ?? after.pieces.at(-1);
    if (stopped) lines.push(pieceProgress(after, stopped.key, { state: 'failed', why: after.why ?? stopped.why ?? 'it gave no reason' }));
  }
  return lines;
}

function latest(records: readonly ProvisioningRecord[]): ProvisioningRecord | undefined {
  return [...records].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

export function provisionedFor(records: readonly ProvisioningRecord[], clusterId: string, revision: number): Provisioned {
  const last = latest(ofCluster(records, clusterId).filter((record) => record.revision === revision));
  if (!last) return { state: 'waiting', line: `nothing has started setting up ${clusterId} for revision ${revision} yet` };
  if (last.state === 'up') return { state: 'up' };
  if (last.state === 'failed') return { state: 'failed', why: last.why ?? 'it gave no reason' };
  const working = last.pieces.find((piece) => piece.state === 'working') ?? last.pieces.find((piece) => piece.state === 'waiting');
  return { state: 'waiting', line: working ? `${working.title}: ${working.line ?? (working.state === 'working' ? 'under way' : 'waiting its turn')}` : `setting up ${nameOf(last.target)}` };
}
