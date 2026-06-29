import { proxyActivities } from '@temporalio/workflow';
import type { DeployAppArgs } from '../activities/DeployAppActivity.js';

const { DeployAppActivity } = proxyActivities<{ DeployAppActivity: DeployAppArgs }>({ startToCloseTimeout: '30 minutes' });

export async function executeDeployAppWorkflow(args: DeployAppArgs) {
  return DeployAppActivity(args);
}
