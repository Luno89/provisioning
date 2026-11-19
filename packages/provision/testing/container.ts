import type { CommandRunner } from '../src/commands.js';
import type { Provider, ServiceContext } from '../src/service.js';
import type { Progress, StepState } from '../src/steps.js';
import { containersOn } from './containers.js';

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

export async function removeContainer(ctx: ContainerContext, name: string, progress: Progress = { line: () => undefined }): Promise<void> {
  const containers = containersOn(ctx.commands);
  if (!await containers.status(name)) return;
  await containers.remove(name);
  progress.line(`removed the container ${name}`);
}

export function containerProvider(spec: ContainerSpec): ContainerProvider {
  const ports = new Map<number, number>();
  const readPorts = async (ctx: ContainerContext): Promise<void> => {
    for (const inner of spec.publish ?? []) ports.set(inner, await containersOn(ctx.commands).published(spec.name, inner));
  };
  return {
    name: spec.name,
    published(inner) {
      const port = ports.get(inner);
      if (!port) throw new Error(`${spec.name} publishes no port for ${inner} yet`);
      return port;
    },
    async running(ctx): Promise<StepState> {
      const status = await containersOn(ctx.commands).status(spec.name);
      if (!status) return { done: false, why: `${spec.name} has no container` };
      if (status.state !== 'running') return { done: false, why: `${spec.name} is ${status.state}` };
      if (ports.size < (spec.publish?.length ?? 0)) await readPorts(ctx);
      return { done: true };
    },
    async start(ctx, progress, unanswered) {
      const containers = containersOn(ctx.commands, progress);
      const status = await containers.status(spec.name);
      if (status && unanswered !== undefined) {
        progress.line(`${spec.name} runs but does not answer (${unanswered}), so it is made again`);
        await removeContainer(ctx, spec.name, progress);
      }
      if (status && unanswered === undefined) await containers.start(spec.name);
      else await containers.run(spec.name, [...spec.run, spec.image, ...(spec.command ?? [])]);
      ports.clear();
    },
    async ended(ctx, progress) {
      const containers = containersOn(ctx.commands, progress);
      const status = await containers.status(spec.name);
      if (!status) return `${spec.name} has no container after it was started`;
      if (!ENDED_FOR_GOOD.has(status.state)) return undefined;
      for (const line of (await containers.logs(spec.name, LOG_LINES)).split('\n')) progress.line(line);
      return `${spec.name} exited with ${status.code}`;
    },
    remove: (ctx, progress) => removeContainer(ctx, spec.name, progress),
  };
}
