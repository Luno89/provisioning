import { ApplicationFailure } from '@temporalio/common';

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

export async function runClusterJob(cluster: NamespacedCluster, input: { name: string; namespace: string; manifest: Record<string, unknown>; timeoutMs: number }, watch: JobWatch): Promise<void> {
  await cluster.kubectl(['delete', 'job', input.name, '--ignore-not-found', '--wait=true']);
  await cluster.apply({ ...input.manifest, metadata: { ...(input.manifest.metadata as object), name: input.name, namespace: input.namespace } });
  const until = Date.now() + input.timeoutMs;
  while (Date.now() < until) {
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
    await sleep(watch.pollMs ?? 5_000);
  }
  const pod = await cluster.kubectl(['get', 'pod', '-l', `job-name=${input.name}`, '-o', 'jsonpath={.items[0].status.phase} {.items[0].status.containerStatuses[0].state.waiting.reason} {.items[0].status.containerStatuses[0].state.waiting.message}']).catch(() => '');
  throw ApplicationFailure.nonRetryable(`${input.name} did not finish in ${Math.round(input.timeoutMs / 60_000)} minutes${pod.trim() ? `; its pod: ${pod.trim().slice(0, 400)}` : ''}`);
}
