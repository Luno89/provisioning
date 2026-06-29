/**
 * DestroyAppWorkflow
 *
 * Orchestrates the lifecycle of an application destruction (CDKTF destroy
 * + Kubernetes namespace deletion).
 */
import { proxyActivities } from '@temporalio/workflow';
import type { DestroyAppArgs } from '../activities/DestroyAppActivity.js';

const { DestroyAppActivity } = proxyActivities<{ DestroyAppActivity: DestroyAppArgs }>({ startToCloseTimeout: '30 minutes' });

export async function executeDestroyAppWorkflow(args: DestroyAppArgs) {
  return DestroyAppActivity(args);
}
