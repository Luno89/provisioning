import { describe, expect, it } from 'vitest';
import { memoryReporter } from '../testing/memory-reporter.js';
import { chartInputs, chartStep, INPUTS_VALUE, type ChartCluster, type ChartRelease } from './chart.js';
import { SETUP_LABEL } from './rollout.js';
import { runSteps, StepFailed } from './steps.js';

const release: ChartRelease = { release: 'instance', namespace: 'nowrinkles', chart: '/work/instance-chart.tgz', values: ['-f', '/work/values.json'], inputs: 'inputs-1' };

const deployment = (available: number) => ({ kind: 'Deployment', metadata: { name: 'instance-backend', generation: 1, annotations: { 'deployment.kubernetes.io/revision': '1' } }, spec: { replicas: 1 }, status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: available } });
const seed = (status: Record<string, unknown>) => ({ kind: 'Job', metadata: { name: 'instance-seed-2', labels: { [SETUP_LABEL]: 'seed' } }, status });

interface Scripted extends ChartCluster {
  helmRan: string[][];
  kubectlRan: string[][];
}

function cluster(world: { listed: { status: string; inputs?: string } | undefined; rollouts: unknown[]; logs?: string }): Scripted {
  const helmRan: string[][] = [];
  const kubectlRan: string[][] = [];
  let looked = 0;
  return {
    helmRan,
    kubectlRan,
    helm: async (args) => {
      helmRan.push([...args]);
      if (args[0] === 'list') return JSON.stringify(world.listed ? [{ name: 'instance', revision: '2', status: world.listed.status }] : []);
      if (args[0] === 'get') return JSON.stringify(world.listed?.inputs ? { [INPUTS_VALUE]: world.listed.inputs } : {});
      if (args[0] === 'upgrade') {
        world.listed = { status: 'deployed', inputs: release.inputs };
        return 'Release "instance" has been upgraded.';
      }
      throw new Error(`helm ${args.join(' ')} was not expected`);
    },
    kubectl: async (args) => {
      kubectlRan.push([...args]);
      if (args[0] === 'logs') return world.logs ?? '';
      const at = Math.min(looked, world.rollouts.length - 1);
      looked += 1;
      return JSON.stringify(world.rollouts[at]);
    },
  };
}

const noPause = { pause: async () => undefined };
const step = chartStep({ id: 'koala', title: 'Putting Koala on this machine' }, release);

describe('what a release is made from', () => {
  it('is one name for the same parts in the same order, and another once any part or their split changes', () => {
    const same = chartInputs(['chart', Buffer.from('values')]);
    expect(chartInputs(['chart', 'values'])).toBe(same);
    expect(chartInputs(['chart', 'values2'])).not.toBe(same);
    expect(chartInputs(['chartv', 'alues'])).not.toBe(same);
    expect(same).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('applying a chart and following it until everything it holds is up', () => {
  it('is not done while the release is missing, failed, made from other inputs, or still rolling out', async () => {
    const ready = { items: [deployment(1), seed({ succeeded: 1 })] };
    expect(await step.check({ cluster: cluster({ listed: undefined, rollouts: [ready] }) })).toEqual({ done: false, why: 'instance is not installed in nowrinkles' });
    expect(await step.check({ cluster: cluster({ listed: { status: 'failed', inputs: 'inputs-1' }, rollouts: [ready] }) })).toEqual({ done: false, why: 'instance is failed' });
    expect(await step.check({ cluster: cluster({ listed: { status: 'deployed', inputs: 'inputs-0' }, rollouts: [ready] }) })).toEqual({ done: false, why: 'instance runs other settings or another chart than these' });
    expect(await step.check({ cluster: cluster({ listed: { status: 'deployed', inputs: 'inputs-1' }, rollouts: [{ items: [deployment(0)] }] }) })).toEqual({ done: false, why: 'it waits: deployment/instance-backend has 0 of 1 available' });
    expect(await step.check({ cluster: cluster({ listed: { status: 'deployed', inputs: 'inputs-1' }, rollouts: [ready] }) })).toEqual({ done: true });
  });

  it('applies the chart without helm waiting or a time limit, then says each change in what it waits on until all is up', async () => {
    const world = cluster({ listed: undefined, rollouts: [
      { items: [deployment(0), seed({})] },
      { items: [deployment(0), seed({})] },
      { items: [deployment(1), seed({ active: 1 })] },
      { items: [deployment(1), seed({ succeeded: 1 })] },
    ] });
    const reporter = memoryReporter();
    await runSteps([step], { cluster: world, wait: noPause }, reporter);
    const upgrade = world.helmRan.find((args) => args[0] === 'upgrade');
    expect(upgrade).toEqual(['upgrade', '--install', 'instance', '/work/instance-chart.tgz', '-n', 'nowrinkles', '--create-namespace', '-f', '/work/values.json', '--set-string', `${INPUTS_VALUE}=inputs-1`]);
    expect(upgrade).not.toContain('--wait');
    expect(upgrade).not.toContain('--timeout');
    expect(world.kubectlRan[0]).toEqual(['get', 'deployments,statefulsets,daemonsets,replicasets,jobs,pods', '-n', 'nowrinkles', '-l', 'app.kubernetes.io/instance=instance', '-o', 'json']);
    expect(reporter.linesOf('koala')).toEqual(['waiting for deployment/instance-backend has 0 of 1 available; job/instance-seed-2 has not started', 'waiting for job/instance-seed-2 runs']);
    expect(reporter.reported.at(-1)).toEqual({ kind: 'done', id: 'koala' });
  });

  it('stops once a setup Job fails, naming it and why, with the end of its log', async () => {
    const world = cluster({
      listed: undefined,
      rollouts: [{ items: [deployment(1), seed({ conditions: [{ type: 'Failed', status: 'True', message: 'Job has reached the specified backoff limit' }] })] }],
      logs: 'seeding app specs\nMongoServerError: not primary\n',
    });
    const reporter = memoryReporter();
    const failed = await runSteps([step], { cluster: world, wait: noPause }, reporter).then(() => undefined, (err: unknown) => err);
    expect(failed).toBeInstanceOf(StepFailed);
    expect((failed as StepFailed).why).toBe('Putting Koala on this machine: job/instance-seed-2 failed: Job has reached the specified backoff limit\nthe end of its log:\nseeding app specs\nMongoServerError: not primary');
    expect(world.kubectlRan.find((args) => args[0] === 'logs')).toEqual(['logs', 'job/instance-seed-2', '-n', 'nowrinkles', '--all-containers', '--tail', '20']);
  });

  it('is already done when the release runs these inputs and everything is up, so a repeated request changes nothing', async () => {
    const world = cluster({ listed: { status: 'deployed', inputs: 'inputs-1' }, rollouts: [{ items: [deployment(1), seed({ succeeded: 1 })] }] });
    const reporter = memoryReporter();
    await runSteps([step], { cluster: world, wait: noPause }, reporter);
    expect(reporter.reported).toEqual([{ kind: 'started', id: 'koala' }, { kind: 'already-done', id: 'koala' }]);
    expect(world.helmRan.some((args) => args[0] === 'upgrade')).toBe(false);
  });
});
