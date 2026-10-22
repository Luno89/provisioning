import { ApplicationFailure } from '@temporalio/common';
import { assessWorkload } from '../infrastructure/index.js';

export interface NamespacedCluster {
  kubectl(args: string[]): Promise<string>;
  apply(manifest: Record<string, unknown>): Promise<void>;
}

export interface JobWatch {
  beat(detail?: unknown): void;
  stopped?: (() => void) | undefined;
  pollMs?: number | undefined;
}

export const inNamespace = (manifest: Record<string, unknown>, namespace: string): Record<string, unknown> =>
  ({ ...manifest, metadata: { ...(manifest.metadata as object), namespace } });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const rolledOut = (said: string): boolean => /successfully rolled out|roll out complete|rolling update complete/i.test(said);

export async function waitUntilRolledOut(cluster: NamespacedCluster, workload: string, watch: JobWatch): Promise<void> {
  const prefix = `${workload.slice(workload.indexOf('/') + 1)}-`;
  for (;;) {
    watch.beat(workload);
    watch.stopped?.();
    const said = await cluster.kubectl(['rollout', 'status', workload, '--watch=false']).catch(() => '');
    if (rolledOut(said)) return;
    const pods = await cluster.kubectl(['get', 'pods', '-o', 'json']).catch(() => '');
    if (pods) {
      const mine = { items: ((JSON.parse(pods) as { items?: { metadata?: { name?: string } }[] }).items ?? []).filter((pod) => pod.metadata?.name?.startsWith(prefix)) };
      const health = assessWorkload(mine);
      if (health.health === 'unhealthy') throw ApplicationFailure.nonRetryable(`${workload} cannot become ready: ${health.reason}`);
    }
    await sleep(watch.pollMs ?? 5_000);
  }
}

export async function runClusterJob(cluster: NamespacedCluster, input: { name: string; namespace: string; manifest: Record<string, unknown> }, watch: JobWatch): Promise<void> {
  await cluster.kubectl(['delete', 'job', input.name, '--ignore-not-found', '--wait=true']);
  await cluster.apply({ ...input.manifest, metadata: { ...(input.manifest.metadata as object), name: input.name, namespace: input.namespace } });
  for (;;) {
    watch.beat(input.name);
    watch.stopped?.();
    const status = await cluster.kubectl(['get', 'job', input.name, '-o', 'jsonpath={.status.succeeded}|{.status.failed}']);
    const [succeeded, failed] = status.split('|').map((value) => Number(value) || 0);
    if (succeeded) return;
    if (failed) {
      const logs = await cluster.kubectl(['logs', `job/${input.name}`, '--tail=30']).catch(() => '');
      const said = logs.split('\n').filter((line) => /ERROR|CRITICAL|Traceback|Error/.test(line)).slice(-6).join('\n') || logs.split('\n').slice(-8).join('\n');
      throw ApplicationFailure.nonRetryable(`${input.name} failed:\n${said.slice(-1500)}`);
    }
    const pods = await cluster.kubectl(['get', 'pods', '-l', `job-name=${input.name}`, '-o', 'json']).catch(() => '');
    const health = pods ? assessWorkload(JSON.parse(pods)) : undefined;
    if (health?.health === 'unhealthy') throw ApplicationFailure.nonRetryable(`${input.name} cannot run: ${health.reason}`);
    await sleep(watch.pollMs ?? 5_000);
  }
}
