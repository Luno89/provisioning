import {
  PROVISION_DONE_STAGE, PROVISION_DONE_TITLE, PROVISION_PIECES,
  type ProvisioningView, type ProvisionPieceKey, type ProvisionPieceView, type ProvisionReason, type ProvisionReport, type ProvisionTarget,
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

export function rootReportOf(record: ProvisioningRecord, progress: MachineProgress): ProvisionReport | undefined {
  return record.target.kind === 'koala' ? { revision: record.revision, progress } : undefined;
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
