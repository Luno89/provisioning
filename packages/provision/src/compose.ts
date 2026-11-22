import type { Command, CommandRunner } from './commands.js';
import { serviceStep, type Provider } from './service.js';
import type { Progress, Step, StepState } from './steps.js';
import type { WaitOptions } from './wait-until.js';

export interface ComposeProject {
  program: readonly [string, ...string[]];
  files: readonly string[];
  project?: string;
  build?: boolean;
}

export interface ComposeContext {
  commands: CommandRunner;
  wait?: WaitOptions;
}

export interface ComposeService {
  id: string;
  title: string;
  compose: ComposeProject;
  answers: () => Promise<StepState>;
}

interface Container {
  service: string;
  state: string;
  oneShot: boolean;
  exitCode: string;
  hash: string;
  id: string;
}

type Restarts = Map<string, number>;

const LOG_LINES = 40;
const ENDED_FOR_GOOD = new Set(['exited', 'dead']);
const ONE_SHOT = 'koala.one-shot';
const completed = (container: Container): boolean => container.oneShot && container.state === 'exited' && container.exitCode === '0';
const quiet: Progress = { line: () => undefined };

export function composeCommand(compose: ComposeProject, args: readonly string[]): Command {
  const [program, ...before] = compose.program;
  return {
    command: program,
    args: [...before, ...(compose.project !== undefined ? ['-p', compose.project] : []), ...compose.files.flatMap((file) => ['-f', file]), ...args],
  };
}

async function configured(ctx: ComposeContext, compose: ComposeProject): Promise<Map<string, string>> {
  const { stdout } = await ctx.commands.run(composeCommand(compose, ['config', '--hash', '*']), quiet);
  return new Map(stdout.split('\n').filter((line) => line.trim() !== '').map((line) => {
    const [service = '', hash = ''] = line.trim().split(/\s+/);
    return [service, hash];
  }));
}

async function containers(ctx: ComposeContext, compose: ComposeProject): Promise<Container[]> {
  const format = `{{.Service}}\t{{.State}}\t{{.ExitCode}}\t{{.Label "com.docker.compose.config-hash"}}\t{{.Label "${ONE_SHOT}"}}\t{{.ID}}`;
  const { stdout } = await ctx.commands.run(composeCommand(compose, ['ps', '-a', '--format', format]), quiet);
  return stdout.split('\n').filter((line) => line.trim() !== '').map((line) => {
    const [service = '', state = '', exitCode = '', hash = '', oneShot = '', id = ''] = line.split('\t');
    return { service, state, exitCode, hash, id: id.trim(), oneShot: oneShot.trim() === 'true' };
  });
}

async function containersState(ctx: ComposeContext, compose: ComposeProject): Promise<StepState> {
  const [wanted, found] = await Promise.all([configured(ctx, compose), containers(ctx, compose)]);
  for (const [service, hash] of wanted) {
    const own = found.filter((container) => container.service === service);
    if (own.length === 0) return { done: false, why: `${service} has no container` };
    const stopped = own.find((container) => container.state !== 'running' && !completed(container));
    if (stopped) return { done: false, why: ENDED_FOR_GOOD.has(stopped.state) ? `${service} exited with ${stopped.exitCode}` : `${service} is ${stopped.state}` };
    if (own.some((container) => container.hash !== hash)) return { done: false, why: `${service} runs with settings older than its compose file's` };
  }
  return { done: true };
}

async function restartsOf(ctx: ComposeContext, found: readonly Container[]): Promise<Restarts> {
  const ids = found.map((container) => container.id).filter((id) => id !== '');
  if (ids.length === 0) return new Map();
  const { stdout } = await ctx.commands.run({ command: 'docker', args: ['inspect', '--format', '{{.Id}} {{.RestartCount}}', ...ids] }, quiet);
  const counted = stdout.split('\n').filter((line) => line.trim() !== '').map((line) => line.trim().split(/\s+/));
  return new Map(ids.flatMap((id) => {
    const [, count] = counted.find(([full = '']) => full.startsWith(id)) ?? [];
    return count === undefined ? [] : [[id, Number(count)]];
  }));
}

async function endedForGood(ctx: ComposeContext, compose: ComposeProject, progress: Progress, before: Restarts): Promise<string | undefined> {
  const [wanted, found] = await Promise.all([configured(ctx, compose), containers(ctx, compose)]);
  const restarts = await restartsOf(ctx, found);
  const logs = (service: string) => ctx.commands.run(composeCommand(compose, ['logs', '--no-color', '--tail', String(LOG_LINES), service]), progress);
  for (const service of wanted.keys()) {
    const own = found.filter((container) => container.service === service);
    if (own.length === 0) return `${service} has no container after it was started`;
    const ended = own.find((container) => ENDED_FOR_GOOD.has(container.state) && !completed(container));
    if (ended) {
      await logs(service);
      return `${service} exited with ${ended.exitCode}`;
    }
    if (own.some((container) => (restarts.get(container.id) ?? 0) > (before.get(container.id) ?? 0))) {
      await logs(service);
      return `${service} keeps exiting as it starts`;
    }
  }
  return undefined;
}

export function composeProvider(title: string, compose: ComposeProject): Provider<ComposeContext> {
  let before: Restarts = new Map();
  return {
    running: (ctx) => containersState(ctx, compose),
    async start(ctx, progress, unanswered) {
      before = await restartsOf(ctx, await containers(ctx, compose));
      if (unanswered !== undefined) progress.line(`${title} runs with the compose file's settings but does not answer (${unanswered}), so its containers are made again`);
      await ctx.commands.run(composeCommand(compose, ['up', '-d', ...(compose.build ? ['--build'] : []), ...(unanswered !== undefined ? ['--force-recreate'] : [])]), progress);
    },
    ended: (ctx, progress) => endedForGood(ctx, compose, progress, before),
  };
}

export function composeStep(service: ComposeService): Step<ComposeContext> {
  return serviceStep({ id: service.id, title: service.title, provider: composeProvider(service.title, service.compose), answers: service.answers });
}
