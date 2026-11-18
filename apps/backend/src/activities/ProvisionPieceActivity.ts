import { ApplicationFailure } from '@temporalio/common';
import { PROVISION_PIECES } from '@koala/engine-core/koala-install';
import {
  pieceHeard, pieceProgress, PLATFORM_PLAN, recordedOn, startedMachine,
  type PieceChange, type ProvisioningRecords, type ProvisionPieceInput,
} from '../infrastructure/index.js';
import { koalaClusterMonitoring } from '../monitoring/index.js';
import type { ClusterSteps } from './cluster-steps.js';
import { installClusterMonitoring, machineMonitoringOf } from './cluster-monitoring.js';
import { provisionPlatformService, type PlatformPlace } from './platform-provision.js';
import type { Pause } from './watched-apply.js';

export interface ProvisionLines {
  heard(input: ProvisionPieceInput, change: PieceChange): Promise<void>;
}

export type ProvisionPlace = Omit<PlatformPlace, 'reach'>;

export interface ProvisionPieceRun extends ProvisionPieceInput {
  kubeconfig?: string | undefined;
}

export interface ProvisionPieceDeps {
  steps: Pick<ClusterSteps, 'access' | 'infra' | 'database' | 'machineMetricsUrl'>;
  place: ProvisionPlace;
  lines: ProvisionLines;
}

type Report = (line: string) => void;

export const recordedLines = (records: ProvisioningRecords, now: () => string = () => new Date().toISOString()): ProvisionLines => ({
  async heard(input, change) {
    const said = await recordedOn(records, input.recordId, (record) => pieceHeard(record, pieceProgress(record, input.piece, change), now()));
    if ('gone' in said) throw ApplicationFailure.nonRetryable(`the setup ${input.recordId} has no record, so what ${input.piece} says has nowhere to go`, 'SetupGone');
    if ('ended' in said) throw ApplicationFailure.nonRetryable(`the setup ${input.recordId} has already ended ${said.ended.state}, so what ${input.piece} says has nowhere to go`, 'SetupEnded');
  },
});

const titleOf = (piece: ProvisionPieceInput['piece']): string => PROVISION_PIECES.find((entry) => entry.key === piece)?.title ?? piece;

function workFor(run: ProvisionPieceRun, { steps, place }: ProvisionPieceDeps, wait: Pause | undefined): (report: Report) => Promise<void> {
  const { target, piece } = run;
  if (target.kind === 'machine') {
    if (piece !== 'monitoring') throw ApplicationFailure.nonRetryable(`${target.machine} gets only its collector set up, not ${titleOf(piece)}`, 'NotAMachinePiece');
    if (!run.kubeconfig) throw ApplicationFailure.nonRetryable(`the collector of ${target.machine} was handed no way to reach ${target.clusterId}, so start its setup again`, 'NoReachHanded');
    const cluster = { physicalName: target.clusterId, reach: startedMachine(target.clusterId, run.kubeconfig), pool: false, machine: machineMonitoringOf(steps, target.clusterId) };
    return (report) => installClusterMonitoring(steps, cluster, { report }, wait);
  }
  const reach = steps.access.own();
  if (piece === 'monitoring') return (report) => installClusterMonitoring(steps, koalaClusterMonitoring(place.pool, reach), { report }, wait);
  const service = PLATFORM_PLAN.find((entry) => entry.key === piece);
  if (!service) throw ApplicationFailure.nonRetryable(`Koala has no platform service ${piece} to set up`, 'UnknownPiece');
  return (report) => provisionPlatformService(steps, { ...place, reach }, service, report, wait);
}

function inOrder(run: ProvisionPieceRun, lines: ProvisionLines): { say(change: PieceChange): void; said(): Promise<void> } {
  let chain = Promise.resolve();
  let unwritten: { error: unknown } | undefined;
  return {
    say(change) {
      chain = chain.then(() => (unwritten ? undefined : lines.heard(run, change))).catch((error: unknown) => { unwritten ??= { error }; });
    },
    async said() {
      await chain;
      if (unwritten) throw unwritten.error;
    },
  };
}

export async function ProvisionPieceActivity(run: ProvisionPieceRun, deps: ProvisionPieceDeps, wait?: Pause): Promise<void> {
  const work = workFor(run, deps, wait);
  const lines = inOrder(run, deps.lines);
  const ended = await work((line) => lines.say({ state: 'started', line })).then(() => undefined, (error: unknown) => ({ error }));
  const unwritten = await lines.said().then(() => undefined, (error: unknown) => ({ error }));
  const failure = ended ?? unwritten;
  if (failure) throw failure.error;
}
