import type { NodeRequest, StepResult } from '@koala/agent-engine/procedure';
import { PROVISION_REASONS, type ProvisionPieceKey, type ProvisionTarget } from '@koala/engine-core/koala-install';
import {
  openedRecord, pieceHeard, pieceProgress, runEnded, setUpProgress,
  type ProvisionPieceInput, type ProvisionPieceResult, type ProvisioningRecord, type ProvisionRunInput,
} from '../../../infrastructure/lib/provisioning.js';
import type { HostOperationRun } from '../../types.js';
import { PROVISION_SERVICES, PROVISION_STATES_MARKED } from './declarations.js';

export interface ProvisioningRecords {
  get(recordId: string): Promise<ProvisioningRecord | undefined>;
  save(record: ProvisioningRecord): Promise<void>;
}

export interface ProvisionPieces {
  run(piece: ProvisionPieceInput, signal?: AbortSignal): Promise<ProvisionPieceResult>;
}

export interface ProvisionOperationDeps {
  records: ProvisioningRecords;
  pieces: ProvisionPieces;
  now?: (() => string) | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function targetOf(value: unknown): ProvisionTarget | undefined {
  if (!isRecord(value) || !isText(value.clusterId)) return undefined;
  if (value.kind === 'koala') return { kind: 'koala', clusterId: value.clusterId };
  if (value.kind === 'machine' && isText(value.machine)) return { kind: 'machine', clusterId: value.clusterId, machine: value.machine };
  return undefined;
}

function runInput(request: NodeRequest): ProvisionRunInput {
  const input = request.run.inputs;
  const target = isRecord(input) ? targetOf(input.target) : undefined;
  const reason = isRecord(input) ? PROVISION_REASONS.find((known) => known === input.reason) : undefined;
  if (!isRecord(input) || !isText(input.ownerId) || !isText(input.recordId) || !target || !reason
    || typeof input.revision !== 'number' || !Number.isInteger(input.revision) || input.revision < 1) {
    throw new Error('this run was not started for a setup: its inputs have no owner, record, cluster, revision and reason');
  }
  return { ownerId: input.ownerId, recordId: input.recordId, target, revision: input.revision, reason };
}

const reasonOf = (err: unknown): string => {
  let reason = 'the setup failed';
  for (let at = err as { message?: string; cause?: unknown } | undefined; at; at = at.cause as typeof at) {
    if (typeof at.message === 'string' && at.message) reason = at.message;
  }
  return reason;
};

const failed = (reason: string): StepResult => ({ exit: 'failed', outputs: { reason } });

const done = (outputs: Record<string, unknown> = {}): StepResult => ({ exit: 'done', outputs });

const gone = (recordId: string): StepResult => failed(`the setup ${recordId} is no longer recorded`);

export function createProvisionOperations(deps: ProvisionOperationDeps): Record<string, HostOperationRun> {
  const now = deps.now ?? (() => new Date().toISOString());
  const { records } = deps;

  const heard = async (recordId: string, change: (record: ProvisioningRecord) => ProvisioningRecord): Promise<boolean> => {
    const record = await records.get(recordId);
    if (!record) return false;
    await records.save(change(record));
    return true;
  };

  const piece = async (request: NodeRequest, key: ProvisionPieceKey): Promise<StepResult> => {
    const run = runInput(request);
    const record = await records.get(run.recordId);
    if (!record) return gone(run.recordId);
    try {
      await records.save(pieceHeard(record, pieceProgress(record, key, { state: 'started' }), now()));
    } catch (err) {
      return failed(reasonOf(err));
    }
    const result = await deps.pieces.run({ ownerId: run.ownerId, recordId: run.recordId, target: run.target, revision: run.revision, piece: key }, request.run.signal)
      .catch((err: unknown): ProvisionPieceResult => ({ ok: false, why: reasonOf(err) }));
    const change = result.ok ? { state: 'done' as const } : { state: 'failed' as const, why: result.why };
    if (!(await heard(run.recordId, (latest) => pieceHeard(latest, pieceProgress(latest, key, change), now())))) return gone(run.recordId);
    return result.ok ? done() : failed(result.why);
  };

  return {
    async 'provision.open'(request) {
      const run = runInput(request);
      const record = await records.get(run.recordId);
      if (!record) {
        await records.save(openedRecord({ ownerId: run.ownerId, target: run.target, revision: run.revision, reason: run.reason, runId: run.recordId, at: now() }));
        return done({ kind: run.target.kind });
      }
      if (record.ownerId !== run.ownerId) return failed(`the setup ${run.recordId} is not ${run.ownerId}'s`);
      if (record.target.clusterId !== run.target.clusterId) return failed(`the setup ${run.recordId} is for ${record.target.clusterId}, not ${run.target.clusterId}`);
      if (record.state !== 'running') return failed(`the setup ${run.recordId} has already ended ${record.state}`);
      return done({ kind: record.target.kind });
    },

    async 'provision.service'(request) {
      const service = PROVISION_SERVICES.find((key) => key === request.node.settings.service);
      if (!service) {
        runInput(request);
        return failed(`${String(request.node.settings.service)} is not one of ${PROVISION_SERVICES.join(', ')}`);
      }
      return piece(request, service);
    },

    async 'provision.monitoring'(request) {
      return piece(request, 'monitoring');
    },

    async 'provision.mark'(request) {
      const run = runInput(request);
      const state = PROVISION_STATES_MARKED.find((known) => known === request.node.settings.state);
      if (!state) return failed(`a setup is marked ${PROVISION_STATES_MARKED.join(' or ')}, not ${String(request.node.settings.state)}`);
      const record = await records.get(run.recordId);
      if (!record) return gone(run.recordId);
      try {
        if (state === 'up') await records.save(pieceHeard(record, setUpProgress(), now()));
        else await records.save(runEnded(record, isText(request.inputs.reason) ? request.inputs.reason : 'it gave no reason', now()));
      } catch (err) {
        return failed(reasonOf(err));
      }
      return done();
    },
  };
}
