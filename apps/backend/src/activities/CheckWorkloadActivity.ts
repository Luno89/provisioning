import fs from 'node:fs/promises';
import { failureOf, ignore } from '@koala/engine-core/failures';
import { ROLLOUT_KINDS, rolloutOf, type WorkloadHealth } from '@koala/provision';
import { namespaceOf, type Reach } from '../infrastructure/index.js';
import type { ClusterSteps } from './cluster-steps.js';
import { handedReach } from './handed-reach.js';

export interface CheckWorkloadArgs {
  name: string;
  namespace?: string | undefined;
  clusterId: string;
  reach?: Reach | undefined;
  kubeconfig?: string | undefined;
  logFile?: string | undefined;
  told?: string | undefined;
}

export interface CheckWorkloadResult {
  health: WorkloadHealth;
  reason: string;
}

export async function CheckWorkloadActivity(args: CheckWorkloadArgs, steps: Pick<ClusterSteps, 'access'>): Promise<CheckWorkloadResult> {
  const reach = handedReach(args);
  const waiting = async (health: 'starting' | 'unknown', reason: string): Promise<CheckWorkloadResult> => {
    if (args.logFile && reason !== args.told) await fs.appendFile(args.logFile, `[deploy] waiting: ${reason}\n`).catch(ignore('the log only shows progress, and the wait goes on without it'));
    return { health, reason };
  };
  let listed: unknown;
  try {
    listed = JSON.parse(await steps.access.kubectl(reach, ['get', ROLLOUT_KINDS, '-n', namespaceOf(args), '-o', 'json']));
  } catch (err) {
    const failure = failureOf(err);
    if (failure.kind === 'final') return { health: 'unhealthy', reason: `the workload could not be read: ${failure.reason}` };
    return waiting('unknown', `the workload cannot be read yet: ${failure.reason}`);
  }
  const rollout = rolloutOf(listed);
  if (rollout.state === 'done') return { health: 'healthy', reason: '' };
  if (rollout.state === 'hopeless') return { health: 'unhealthy', reason: rollout.reason };
  return waiting('starting', rollout.waiting);
}
