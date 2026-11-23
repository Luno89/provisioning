import { ApplicationFailure } from '@temporalio/common';
import { assessWorkload, ROLLOUT_KINDS, rolloutOfOne } from '@koala/provision';
import type { ClusterAccess } from '../infrastructure/index.js';
import { failureOf } from '@koala/engine-core/failures';
import { messageOf, waitingOn } from './failure-reasons.js';

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

type Target = Parameters<ClusterAccess['kubectl']>[0];

export function namespacedOn(access: Pick<ClusterAccess, 'kubectl' | 'apply'>, target: Target | (() => Target), namespace: string, beforeApply: (target: Target) => Promise<void> = async () => undefined): NamespacedCluster {
  const reached = (): Target => (typeof target === 'function' ? target() : target);
  return {
    kubectl: async (args) => access.kubectl(reached(), ['-n', namespace, ...args]),
    apply: async (manifest) => {
      const at = reached();
      await beforeApply(at);
      await access.apply(at, JSON.stringify(inNamespace(manifest, namespace)));
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function askedAgainUnlessFinal(what: string): (failure: unknown) => undefined {
  const waiting = waitingOn(what);
  return (err) => {
    const failure = failureOf(err);
    if (failure.kind === 'final') throw ApplicationFailure.nonRetryable(`${what} cannot be asked: ${failure.reason}`);
    waiting(failure.reason);
    return undefined;
  };
}

export async function waitUntilRolledOut(cluster: NamespacedCluster, workload: string, watch: JobWatch): Promise<void> {
  const unanswered = askedAgainUnlessFinal(`the rollout of ${workload}`);
  for (;;) {
    watch.beat(workload);
    watch.stopped?.();
    const listed = await cluster.kubectl(['get', ROLLOUT_KINDS, '-o', 'json']).then((said) => JSON.parse(said) as unknown, unanswered);
    if (listed !== undefined) {
      const rollout = rolloutOfOne(listed, workload);
      if (rollout.state === 'done') return;
      if (rollout.state === 'hopeless') throw ApplicationFailure.nonRetryable(`${workload} cannot become ready: ${rollout.reason}`);
    }
    await sleep(watch.pollMs ?? 5_000);
  }
}

export async function runClusterJob(cluster: NamespacedCluster, input: { name: string; namespace: string; manifest: Record<string, unknown> }, watch: JobWatch): Promise<void> {
  const unanswered = askedAgainUnlessFinal(`the job ${input.name} in ${input.namespace}`);
  await cluster.kubectl(['delete', 'job', input.name, '--ignore-not-found', '--wait=true']);
  await cluster.apply({ ...input.manifest, metadata: { ...(input.manifest.metadata as object), name: input.name, namespace: input.namespace } });
  for (;;) {
    watch.beat(input.name);
    watch.stopped?.();
    const status = await cluster.kubectl(['get', 'job', input.name, '-o', 'jsonpath={.status.succeeded}|{.status.failed}']);
    const [succeeded, failed] = status.split('|').map((value) => Number(value) || 0);
    if (succeeded) return;
    if (failed) {
      const logs = await cluster.kubectl(['logs', `job/${input.name}`, '--tail=30']).catch((err: unknown) => `its log could not be read: ${messageOf(err)}`);
      const said = logs.split('\n').filter((line) => /ERROR|CRITICAL|Traceback|Error/.test(line)).slice(-6).join('\n') || logs.split('\n').slice(-8).join('\n');
      throw ApplicationFailure.nonRetryable(`${input.name} failed:\n${said.slice(-1500)}`);
    }
    const pods = await cluster.kubectl(['get', 'pods', '-l', `job-name=${input.name}`, '-o', 'json']).catch(unanswered);
    const health = pods ? assessWorkload(JSON.parse(pods)) : undefined;
    if (health?.health === 'unhealthy') throw ApplicationFailure.nonRetryable(`${input.name} cannot run: ${health.reason}`);
    await sleep(watch.pollMs ?? 5_000);
  }
}
