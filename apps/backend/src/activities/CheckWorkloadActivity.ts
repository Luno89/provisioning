/**
 * One look at what a deployment's pods are doing. Short, cheap, and called repeatedly.
 *
 * ── WHY A SHORT ACTIVITY RATHER THAN A LONG WAIT ──
 * A pod can take a very long time to come up. This codebase already learned that the expensive
 * way: a TabbyAPI deploy downloading a model needed more than thirty minutes, and a hardcoded
 * timeout killed it before it finished. So the waiting itself belongs in the workflow, as durable
 * timers, and this is only the question asked at each tick.
 *
 * The alternative — one activity that sits and polls for half an hour — puts the wait in a place
 * that does not survive a worker restart without heartbeats, and turns "still starting" into a
 * timeout of its own.
 */
import { createDatabase } from '../lib/db-interface.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { ClusterService } from '../services/ClusterService.js';
import { sanitizeNamespace } from '../lib/model-registry.js';
import { assessWorkload, type WorkloadHealth } from '../lib/workload-health.js';

export interface CheckWorkloadArgs {
  /**
   * The deployment's NAME, not its record id.
   *
   * The namespace is derived from the name, and the name is already in the deploy workflow's
   * arguments — so this needs no new plumbing. The `deploymentId` those args carry is a short
   * random suffix used for object naming, not the record's id: looking a deployment up by it finds
   * nothing, which is exactly the mistake this signature avoids repeating.
   */
  name: string;
  clusterId: string;
}

export interface CheckWorkloadResult {
  health: WorkloadHealth;
  reason: string;
}

export async function CheckWorkloadActivity(args: CheckWorkloadArgs): Promise<CheckWorkloadResult> {
  const db = createDatabase();
  await db.init();
  try {
    const infra = new InfrastructureService();
    const clusters = new ClusterService(db, infra);
    const cluster = await clusters.getByIdUnscoped(args.clusterId);
    if (!cluster) return { health: 'unknown', reason: 'cluster no longer exists' };

    const kubeconfig = await clusters.getKubeconfigPath(cluster);
    const raw = await infra.runKubectl(
      ['get', 'pods', '-n', sanitizeNamespace(args.name), '-o', 'json'],
      kubeconfig,
    );
    return assessWorkload(JSON.parse(raw));
  } catch (err) {
    /**
     * Unreadable is not unhealthy.
     *
     * A cluster that is briefly unreachable, or a namespace that has not been created yet, says
     * nothing about the workload — and returning `unhealthy` here would fail a deploy over a
     * transient kubectl error.
     */
    return { health: 'unknown', reason: `could not read the workload: ${(err as Error).message}` };
  } finally {
    await db.close();
  }
}
