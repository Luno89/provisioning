import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { chartInputs, chartStep, runSteps, StepFailed, type ChartRelease } from '@koala/provision';
import { memoryReporter } from '@koala/provision/testing';
import { nodeProcesses, nodeStreams } from '../../platform/index.js';
import { TOOLS } from '../testing/real-k3s.js';
import { testNamespaces } from '../testing/test-namespaces.js';
import { tinyChart } from '../testing/tiny-chart.js';
import { ClusterAccess } from './ClusterAccess.js';

const k3s = inject('k3s');
const namespaces = testNamespaces(k3s.admin);
afterAll(async () => { await namespaces.removeAll(); }, 0);


function onK3s() {
  const access = new ClusterAccess({ here: { root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-chart-step-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS });
  return access.chartCluster({ clusterId: 'tiny', kind: 'machine', kubeconfig: k3s.admin });
}

const releaseIn = (namespace: string, chart: string, values: string[]): ChartRelease =>
  ({ release: 'tiny', namespace, chart, values, inputs: chartInputs([chart, ...values]) });

const step = (release: ChartRelease) => chartStep({ id: 'tiny', title: 'Putting the tiny chart on k3s' }, release);

describe('a chart applied and followed by the one install step, on a real k3s', () => {
  it('applies it, follows its workload and its setup Job until both are done, and finds it done when asked again', async () => {
    const cluster = onK3s();
    const release = releaseIn(namespaces.name('tiny-up'), tinyChart(), []);
    const first = memoryReporter();
    await runSteps([step(release)], { cluster }, first);
    expect(first.reported.at(-1)).toEqual({ kind: 'done', id: 'tiny' });
    expect(first.linesOf('tiny').every((line) => line.startsWith('waiting for '))).toBe(true);
    const again = memoryReporter();
    await runSteps([step(release)], { cluster }, again);
    expect(again.reported).toEqual([{ kind: 'started', id: 'tiny' }, { kind: 'already-done', id: 'tiny' }]);
    const listed = JSON.parse(await cluster.helm(['list', '-n', release.namespace, '-o', 'json'])) as Array<{ revision: string; status: string }>;
    expect(listed).toMatchObject([{ revision: '1', status: 'deployed' }]);
  }, 300_000);

  it('stops once its setup Job fails, naming the Job and why, with the end of its log', async () => {
    const release = releaseIn(namespaces.name('tiny-job'), tinyChart(), ['--set-string', 'setup=echo the seed found no Mongo; exit 3']);
    const failed = await runSteps([step(release)], { cluster: onK3s() }, memoryReporter()).then(() => undefined, (err: unknown) => err);
    expect(failed).toBeInstanceOf(StepFailed);
    expect((failed as StepFailed).why).toMatch(/^Putting the tiny chart on k3s: job\/tiny-setup-1 failed: .+\nthe end of its log:\nthe seed found no Mongo$/);
  }, 300_000);

  it('stops once its workload\'s image can never be pulled, naming the pod and why', async () => {
    const release = releaseIn(namespaces.name('tiny-pull'), tinyChart(), ['--set-string', 'image=registry.invalid/koala/none:1']);
    const failed = await runSteps([step(release)], { cluster: onK3s() }, memoryReporter()).then(() => undefined, (err: unknown) => err);
    expect(failed).toBeInstanceOf(StepFailed);
    expect((failed as StepFailed).why).toMatch(/^Putting the tiny chart on k3s: tiny-app-[a-z0-9-]+: (ErrImagePull|ImagePullBackOff), its image registry\.invalid\/koala\/none:1 could not be pulled/);
  }, 300_000);
});
