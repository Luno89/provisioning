import { resolve } from 'node:path';
import type { CommandRunner } from '../src/commands.js';
import type { Progress } from '../src/steps.js';

const LABEL = 'koala.throwaway-of';
const CHECKOUT_LABEL = 'koala.throwaway-checkout';
export const THIS_CHECKOUT = resolve(import.meta.dirname, '../../..');

export const throwawayLabel = (pid: number = process.pid, checkout: string = THIS_CHECKOUT): string[] => ['--label', `${LABEL}=${pid}`, '--label', `${CHECKOUT_LABEL}=${checkout}`];

export interface ContainerStatus {
  state: string;
  code: string;
}

export interface InsideOptions {
  user?: string;
  input?: string;
  env?: Readonly<Record<string, string>>;
}

export interface Containers {
  status(name: string): Promise<ContainerStatus | undefined>;
  addressOf(name: string): Promise<string>;
  idOf(name: string): Promise<string>;
  run(name: string, args: readonly string[]): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  restart(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  exec(name: string, command: readonly string[], options?: InsideOptions): Promise<string>;
  logs(name: string, lines: number): Promise<string>;
  copyOut(name: string, path: string, to: string): Promise<void>;
  published(name: string, inner: number): Promise<number>;
  memoryInUse(name: string): Promise<number>;
  named(filter: string): Promise<string[]>;
  throwawayOrphans(checkout?: string): Promise<string[]>;
  sweepThrowaways(checkout?: string): Promise<string[]>;
  imageThere(image: string): Promise<boolean>;
  build(image: string, context: string, args?: readonly string[]): Promise<void>;
  tag(image: string, as: string): Promise<void>;
  push(image: string): Promise<void>;
}

const quiet: Progress = { line: () => undefined };

const MEMORY_UNITS: Readonly<Record<string, number>> = {
  B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4, kB: 1000, KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, TB: 1000 ** 4,
};

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export function containersOn(commands: CommandRunner, progress: Progress = quiet): Containers {
  const docker = async (args: readonly string[], options: { accept?: number[]; stdin?: string; env?: Readonly<Record<string, string>>; said?: Progress } = {}) =>
    commands.run({ command: 'docker', args: [...args], ...(options.accept ? { accept: options.accept } : {}), ...(options.stdin !== undefined ? { stdin: options.stdin } : {}), ...(options.env ? { env: options.env } : {}) }, options.said ?? progress);
  const said = async (args: readonly string[]): Promise<string> => (await docker(args)).stdout.trim();

  const containers: Containers = {
    async status(name) {
      const found = await docker(['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', name], { accept: [0, 1], said: quiet });
      if (found.code !== 0) return undefined;
      const [state = '', code = ''] = found.stdout.trim().split(' ');
      return { state, code };
    },
    addressOf: (name) => said(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name]),
    idOf: (name) => said(['inspect', '-f', '{{.Id}}', name]),
    async run(name, args) { await docker(['run', '-d', '--name', name, ...args]); },
    async start(name) { await docker(['start', name]); },
    async stop(name) { await docker(['stop', name]); },
    async restart(name) { await docker(['restart', name]); },
    async remove(name) {
      if (!await containers.status(name)) return;
      await docker(['stop', '--signal', 'KILL', '--timeout', '-1', name], { said: quiet });
      await docker(['rm', '--volumes', name], { said: quiet });
    },
    exec: async (name, command, options = {}) => (await docker([
      'exec',
      ...(options.input !== undefined ? ['-i'] : []),
      ...(options.user !== undefined ? ['--user', options.user] : []),
      ...Object.entries(options.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      name,
      ...command,
    ], options.input !== undefined ? { stdin: options.input } : {})).stdout.trim(),
    async logs(name, lines) {
      const told: string[] = [];
      await docker(['logs', '--tail', String(lines), name], { said: { line: (line) => { told.push(line); } } });
      return told.join('\n').trim();
    },
    async copyOut(name, path, to) { await docker(['cp', `${name}:${path}`, to]); },
    async published(name, inner) {
      const first = (await said(['port', name, String(inner)])).split('\n')[0] ?? '';
      const port = Number(first.split(':').pop()?.trim());
      if (!Number.isInteger(port) || port <= 0) throw new Error(`${name} publishes no port for ${inner}: docker said ${first || 'nothing'}`);
      return port;
    },
    async memoryInUse(name) {
      const reading = await said(['stats', '--no-stream', '--format', '{{.MemUsage}}', name]);
      const used = /^([\d.]+)\s*([kKMGT]?i?B)\b/.exec(reading);
      const scale = used ? MEMORY_UNITS[used[2]!] : undefined;
      if (!used || scale === undefined) throw new Error(`Docker said "${reading}" for the memory ${name} uses`);
      return Math.round(Number(used[1]) * scale);
    },
    named: async (filter) => (await said(['ps', '--filter', filter, '--format', '{{.Names}}'])).split('\n').filter(Boolean),
    async throwawayOrphans(checkout = THIS_CHECKOUT) {
      const listed = await said(['ps', '-a', '--filter', `label=${CHECKOUT_LABEL}=${checkout}`, '--format', `{{.Names}} {{.Label "${LABEL}"}}`]);
      return listed.split('\n').map((line) => line.trim().split(' ')).filter(([name, pid]) => name && pid && !running(Number(pid))).map(([name]) => name!);
    },
    async sweepThrowaways(checkout = THIS_CHECKOUT) {
      const orphans = await containers.throwawayOrphans(checkout);
      for (const orphan of orphans) await containers.remove(orphan);
      return orphans;
    },
    imageThere: async (image) => (await docker(['image', 'inspect', image], { accept: [0, 1], said: quiet })).code === 0,
    async build(image, context, args = []) { await docker(['build', '-q', ...args, '-t', image, context], { env: { DOCKER_BUILDKIT: '1' } }); },
    async tag(image, as) { await docker(['tag', image, as]); },
    async push(image) { await docker(['push', '-q', image]); },
  };
  return containers;
}
