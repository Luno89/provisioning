import { ApplicationFailure, condition, defineSignal, setHandler } from '@temporalio/workflow';

export const deployEnds = defineSignal('deploy-ends');

export async function DeployFixtureWorkflow(say: string): Promise<unknown> {
  if (say === 'unhealthy') return { workload: 'unhealthy', workloadReason: 'odoo-web is CrashLoopBackOff: the addons path is missing' };
  if (say === 'broken') throw ApplicationFailure.nonRetryable('the image registry.koala/odoo:17 could not be pulled');
  if (say === 'held') {
    let ended = false;
    setHandler(deployEnds, () => { ended = true; });
    await condition(() => ended);
  }
  return { workload: 'healthy' };
}
