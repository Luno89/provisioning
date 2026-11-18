import type { NodeRequest, StepResult } from '@koala/agent-engine/procedure';
import { PROVISION_REASONS, type ProvisionPieceKey, type ProvisionTarget } from '@koala/engine-core/koala-install';
import {
  pieceHeard, pieceProgress, recordedOn, runEnded, setUpProgress,
  type ProvisionPieceInput, type ProvisionPieceResult, type ProvisioningRecord, type ProvisioningRecords, type ProvisionRunInput,
} from '../../../infrastructure/lib/provisioning.js';
import type { HostOperationRun } from '../../types.js';
import { PROVISION_SERVICES, PROVISION_STATES_MARKED } from './declarations.js';

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
  if (value.kind === 'machine' && isText(value.machine) && isText(value.deviceId)) return { kind: 'machine', clusterId: value.clusterId, machine: value.machine, deviceId: value.deviceId };
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

const endedAlready = (record: ProvisioningRecord): StepResult => failed(`the setup ${record.id} has already ended ${record.state}`);

export function createProvisionOperations(deps: ProvisionOperationDeps): Record<string, HostOperationRun> {
  const now = deps.now ?? (() => new Date().toISOString());
  const { records } = deps;

  const written = async (recordId: string, change: (record: ProvisioningRecord) => ProvisioningRecord): Promise<StepResult | undefined> => {
    const said = await recordedOn(records, recordId, change).catch((err: unknown) => ({ broke: reasonOf(err) }));
    if ('broke' in said) return failed(said.broke);
    if ('gone' in said) return gone(recordId);
    if ('ended' in said) return endedAlready(said.ended);
    return undefined;
  };

  const piece = async (request: NodeRequest, key: ProvisionPieceKey): Promise<StepResult> => {
    const run = runInput(request);
    const unstarted = await written(run.recordId, (record) => pieceHeard(record, pieceProgress(record, key, { state: 'started' }), now()));
    if (unstarted) return unstarted;
    const result = await deps.pieces.run({ ownerId: run.ownerId, recordId: run.recordId, target: run.target, revision: run.revision, piece: key }, request.run.signal)
      .catch((err: unknown): ProvisionPieceResult => ({ ok: false, why: reasonOf(err) }));
    const change = result.ok ? { state: 'done' as const } : { state: 'failed' as const, why: result.why };
    const unheard = await written(run.recordId, (latest) => pieceHeard(latest, pieceProgress(latest, key, change), now()));
    if (unheard) return unheard;
    return result.ok ? done() : failed(result.why);
  };

  return {
    async 'provision.open'(request) {
      const run = runInput(request);
      const record = await records.getProvisioningRun(run.recordId);
      if (!record) return gone(run.recordId);
      if (record.ownerId !== run.ownerId) return failed(`the setup ${run.recordId} is not ${run.ownerId}'s`);
      if (record.target.clusterId !== run.target.clusterId) return failed(`the setup ${run.recordId} is for ${record.target.clusterId}, not ${run.target.clusterId}`);
      if (record.revision !== run.revision) return failed(`the setup ${run.recordId} is for revision ${record.revision}, not ${run.revision}`);
      if (record.state !== 'running') return endedAlready(record);
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
      const said = await recordedOn(records, run.recordId, (record) => (state === 'up'
        ? pieceHeard(record, setUpProgress(), now())
        : runEnded(record, isText(request.inputs.reason) ? request.inputs.reason : 'it gave no reason', now()))).catch((err: unknown) => ({ broke: reasonOf(err) }));
      if ('broke' in said) return failed(said.broke);
      if ('gone' in said) return gone(run.recordId);
      if ('ended' in said && said.ended.state !== state) return endedAlready(said.ended);
      return done();
    },
  };
}
