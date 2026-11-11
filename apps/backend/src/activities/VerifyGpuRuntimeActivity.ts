import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ignore } from '@koala/engine-core/failures';
import type { GpuVendor } from '@koala/engine-core';
import { advertisedGpus, assessWorkload, GPU_PLUGINS, gpuPluginState, runtimeRefused, type Reach, type WorkloadStatus } from '../infrastructure/index.js';
import type { ClusterSteps } from './cluster-steps.js';
import { handedReach } from './handed-reach.js';

export interface VerifyGpuRuntimeArgs {
  clusterId: string;
  reach?: Reach | undefined;
  vendor?: GpuVendor | undefined;
  count?: number | undefined;
  machine?: string | undefined;
  logFile?: string | undefined;
}

export class GpusCannotRun extends Error {
  constructor(readonly why: string) {
    super(why);
    this.name = 'GpusCannotRun';
  }
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const pause = (ms: number) => new Promise<void>((done) => { setTimeout(done, ms); });

export async function VerifyGpuRuntimeActivity(args: VerifyGpuRuntimeArgs, steps: Pick<ClusterSteps, 'access'>, wait: (ms: number) => Promise<void> = pause): Promise<void> {
  if (!args.count || args.count < 1) throw new GpusCannotRun('the deploy did not say how many GPUs it uses: deploy it again, saying 1 or more, or 0 for CPU only');
  if (!args.vendor) throw new GpusCannotRun('the deploy did not say which GPUs it uses: deploy it again, and Koala takes them from what the machine reports');
  const reach = handedReach(args);
  const machine = args.machine ?? args.clusterId;
  const plugin = GPU_PLUGINS[args.vendor];
  const note = (line: string) => (args.logFile ? appendFile(args.logFile, `[gpus] ${line}\n`).catch(ignore('the log only shows progress, and the readying goes on without it')) : Promise.resolve());
  const read = async (argv: string[]): Promise<{ json: unknown } | { unread: string }> => {
    try {
      return { json: JSON.parse(await steps.access.kubectl(reach, argv)) as unknown };
    } catch (err) {
      return { unread: (err as Error).message.split('\n')[0] ?? 'no answer' };
    }
  };

  await steps.access.apply(reach, await readFile(path.join(REPO, plugin.manifest), 'utf8'));
  const want = { vendor: args.vendor, count: args.count };
  let said = '';
  for (;;) {
    const [nodes, pods, events] = await Promise.all([
      read(['get', 'nodes', '-o', 'json']),
      read(['get', 'pods', '-n', plugin.namespace, '-l', plugin.selector, '-o', 'json']),
      read(['get', 'events', '-n', plugin.namespace, '--field-selector', 'involvedObject.kind=Pod', '-o', 'json']),
    ]);
    const refused = 'json' in events ? runtimeRefused(events.json) : undefined;
    const health: WorkloadStatus = refused ? { health: 'unhealthy', reason: refused } : 'json' in pods ? assessWorkload(pods.json) : { health: 'unknown', reason: pods.unread };
    const advertised = 'json' in nodes ? advertisedGpus(nodes.json, plugin.resource) : 0;
    const state = gpuPluginState(want, advertised, health, machine);
    if (state.state === 'ready') {
      await note(`${machine} advertises ${advertised} ${plugin.label} GPU${advertised === 1 ? '' : 's'} to the scheduler`);
      return;
    }
    if (state.state === 'failed') throw new GpusCannotRun(state.reason);
    const now = 'unread' in nodes ? `${state.reason}; the node could not be read: ${nodes.unread}` : state.reason;
    if (now !== said) await note(now);
    said = now;
    await wait(2_000);
  }
}
