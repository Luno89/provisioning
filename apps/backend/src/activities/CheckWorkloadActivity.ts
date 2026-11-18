import fs from 'node:fs/promises';
import { ignore } from '@koala/engine-core/failures';
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
  try {
    const rollout = rolloutOf(JSON.parse(await steps.access.kubectl(reach, ['get', ROLLOUT_KINDS, '-n', namespaceOf(args), '-o', 'json'])));
    if (rollout.state === 'done') return { health: 'healthy', reason: '' };
    if (rollout.state === 'hopeless') return { health: 'unhealthy', reason: rollout.reason };
    if (args.logFile && rollout.waiting !== args.told) await fs.appendFile(args.logFile, `[deploy] waiting: ${rollout.waiting}\n`).catch(ignore('the log only shows progress, and the wait goes on without it'));
    return { health: 'starting', reason: rollout.waiting };
  } catch (err) {
    return { health: 'unknown', reason: `could not read the workload: ${(err as Error).message}` };
  }
}
