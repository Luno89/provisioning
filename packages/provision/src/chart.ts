import { createHash } from 'node:crypto';
import { releaseRollout, ROLLOUT_KINDS, type ReleaseRollout } from './rollout.js';
import type { Progress, Step, StepName, StepState } from './steps.js';
import { waitUntil, type WaitOptions } from './wait-until.js';

export interface ChartCluster {
  helm(args: readonly string[]): Promise<string>;
  kubectl(args: readonly string[]): Promise<string>;
}

export interface ChartRelease {
  release: string;
  namespace: string;
  chart: string;
  values: readonly string[];
  inputs: string;
}

export interface ChartContext {
  cluster: ChartCluster;
  wait?: WaitOptions;
}

export const INPUTS_VALUE = 'koalaInputs';
export const LOG_TAIL_LINES = 20;

export function chartInputs(parts: readonly (string | Uint8Array)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part) : part;
    hash.update(`${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

interface Listed {
  revision?: string;
  status?: string;
}

async function listed(ctx: ChartContext, release: Pick<ChartRelease, 'release' | 'namespace'>): Promise<Listed | undefined> {
  const found = JSON.parse(await ctx.cluster.helm(['list', '-n', release.namespace, '--filter', `^${release.release}$`, '-a', '-o', 'json'])) as Listed[];
  return found[0];
}

export async function releaseRevision(ctx: ChartContext, release: Pick<ChartRelease, 'release' | 'namespace'>): Promise<number> {
  const found = await listed(ctx, release);
  if (!found) throw new Error(`${release.release} is not installed in ${release.namespace}, so it runs no revision`);
  const revision = Number(found.revision);
  if (!Number.isInteger(revision) || revision < 1) throw new Error(`helm lists ${release.release} in ${release.namespace} with no revision it can name (${String(found.revision)})`);
  return revision;
}

async function inputsOf(ctx: ChartContext, release: ChartRelease): Promise<unknown> {
  const values = JSON.parse(await ctx.cluster.helm(['get', 'values', release.release, '-n', release.namespace, '-o', 'json'])) as Record<string, unknown> | null;
  return values?.[INPUTS_VALUE];
}

async function rolloutOfRelease(ctx: ChartContext, release: Pick<ChartRelease, 'release' | 'namespace'>): Promise<ReleaseRollout> {
  const listing: unknown = JSON.parse(await ctx.cluster.kubectl(['get', ROLLOUT_KINDS, '-n', release.namespace, '-l', `app.kubernetes.io/instance=${release.release}`, '-o', 'json']));
  return releaseRollout(listing);
}

async function stateOf(ctx: ChartContext, release: ChartRelease): Promise<StepState> {
  const found = await listed(ctx, release);
  if (!found) return { done: false, why: `${release.release} is not installed in ${release.namespace}` };
  if (found.status !== 'deployed') return { done: false, why: `${release.release} is ${found.status ?? 'in no state helm names'}` };
  if (await inputsOf(ctx, release) !== release.inputs) return { done: false, why: `${release.release} runs other settings or another chart than these` };
  const rollout = await rolloutOfRelease(ctx, release);
  if (rollout.state === 'done') return { done: true };
  return { done: false, why: rollout.state === 'rolling' ? `it waits: ${rollout.waiting.join('; ')}` : rollout.reason };
}

async function logTail(ctx: ChartContext, release: Pick<ChartRelease, 'namespace'>, job: string): Promise<string> {
  try {
    const log = (await ctx.cluster.kubectl(['logs', `job/${job}`, '-n', release.namespace, '--all-containers', '--tail', String(LOG_TAIL_LINES)])).trimEnd();
    return log ? `\nthe end of its log:\n${log}` : '\nit wrote no log';
  } catch (err) {
    return `\nits log could not be read: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function chartStep(name: StepName, release: ChartRelease): Step<ChartContext> {
  return {
    id: name.id,
    title: name.title,
    check: (ctx) => stateOf(ctx, release),
    async apply(ctx, progress) {
      await ctx.cluster.helm([
        'upgrade', '--install', release.release, release.chart, '-n', release.namespace, '--create-namespace',
        ...release.values,
        '--set-string', `${INPUTS_VALUE}=${release.inputs}`,
      ]);
      await followRelease(ctx, release, name.title, progress);
    },
  };
}

export async function followRelease(ctx: ChartContext, release: Pick<ChartRelease, 'release' | 'namespace'>, what: string, progress: Progress): Promise<void> {
  let said = '';
  let hopeless: string | undefined;
  await waitUntil(
    what,
    async () => {
      const rollout = await rolloutOfRelease(ctx, release);
      if (rollout.state === 'done') return true;
      if (rollout.state === 'hopeless') {
        hopeless = rollout.job ? `${rollout.reason}${await logTail(ctx, release, rollout.job)}` : rollout.reason;
        return undefined;
      }
      const line = `waiting for ${rollout.waiting.join('; ')}`;
      if (line !== said) progress.line(line);
      said = line;
      return undefined;
    },
    async () => hopeless,
    ctx.wait,
  );
}
