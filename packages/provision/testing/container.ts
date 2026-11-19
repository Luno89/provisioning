import type { CommandRunner } from '../src/commands.js';
import type { Provider, ServiceContext } from '../src/service.js';
import type { Progress, StepState } from '../src/steps.js';

export interface ContainerContext extends ServiceContext {
  commands: CommandRunner;
}

export interface ContainerSpec {
  name: string;
  image: string;
  run: readonly string[];
  command?: readonly string[];
  publish?: readonly number[];
}

export interface ContainerProvider extends Provider<ContainerContext> {
  readonly name: string;
  published(inner: number): number;
}

const LOG_LINES = 20;
const ENDED_FOR_GOOD = new Set(['exited', 'dead']);
const quiet: Progress = { line: () => undefined };

const docker = async (ctx: ContainerContext, args: readonly string[], progress: Progress = quiet, accept: number[] = [0]) =>
  ctx.commands.run({ command: 'docker', args: [...args], accept }, progress);

async function statusOf(ctx: ContainerContext, name: string): Promise<{ state: string; code: string } | undefined> {
  const found = await docker(ctx, ['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', name], quiet, [0, 1]);
  if (found.code !== 0) return undefined;
  const [state = '', code = ''] = found.stdout.trim().split(' ');
  return { state, code };
}

export async function removeContainer(ctx: ContainerContext, name: string, progress: Progress = quiet): Promise<void> {
  if (!await statusOf(ctx, name)) return;
  await docker(ctx, ['stop', '--signal', 'KILL', '--timeout', '-1', name], quiet);
  await docker(ctx, ['rm', '--volumes', name], quiet);
  progress.line(`removed the container ${name}`);
}

export function containerProvider(spec: ContainerSpec): ContainerProvider {
  const ports = new Map<number, number>();
  const readPorts = async (ctx: ContainerContext): Promise<void> => {
    for (const inner of spec.publish ?? []) {
      const said = (await docker(ctx, ['port', spec.name, String(inner)])).stdout.split('\n')[0] ?? '';
      ports.set(inner, Number(said.split(':').pop()?.trim()));
    }
  };
  return {
    name: spec.name,
    published(inner) {
      const port = ports.get(inner);
      if (!port) throw new Error(`${spec.name} publishes no port for ${inner} yet`);
      return port;
    },
    async running(ctx): Promise<StepState> {
      const status = await statusOf(ctx, spec.name);
      if (!status) return { done: false, why: `${spec.name} has no container` };
      if (status.state !== 'running') return { done: false, why: `${spec.name} is ${status.state}` };
      if (ports.size < (spec.publish?.length ?? 0)) await readPorts(ctx);
      return { done: true };
    },
    async start(ctx, progress, unanswered) {
      const status = await statusOf(ctx, spec.name);
      if (status && unanswered !== undefined) {
        progress.line(`${spec.name} runs but does not answer (${unanswered}), so it is made again`);
        await removeContainer(ctx, spec.name, progress);
      }
      if (status && unanswered === undefined) await docker(ctx, ['start', spec.name], progress);
      else await docker(ctx, ['run', '-d', '--name', spec.name, ...spec.run, spec.image, ...(spec.command ?? [])], progress);
      ports.clear();
    },
    async ended(ctx, progress) {
      const status = await statusOf(ctx, spec.name);
      if (!status) return `${spec.name} has no container after it was started`;
      if (!ENDED_FOR_GOOD.has(status.state)) return undefined;
      await docker(ctx, ['logs', '--tail', String(LOG_LINES), spec.name], progress);
      return `${spec.name} exited with ${status.code}`;
    },
    remove: (ctx, progress) => removeContainer(ctx, spec.name, progress),
  };
}
