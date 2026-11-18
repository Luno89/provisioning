import { failureOf, stillDown } from '@koala/engine-core/failures';
import type { Command, CommandRunner } from './commands.js';
import type { Progress, Step, StepState } from './steps.js';
import { Hopeless, waitUntil, type WaitOptions } from './wait-until.js';

export interface ComposeProject {
  program: readonly [string, ...string[]];
  files: readonly string[];
  project?: string;
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
  exitCode: string;
  hash: string;
}

const LOG_LINES = 40;
const ENDED_FOR_GOOD = new Set(['exited', 'dead']);
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
  const format = '{{.Service}}\t{{.State}}\t{{.ExitCode}}\t{{.Label "com.docker.compose.config-hash"}}';
  const { stdout } = await ctx.commands.run(composeCommand(compose, ['ps', '-a', '--format', format]), quiet);
  return stdout.split('\n').filter((line) => line.trim() !== '').map((line) => {
    const [service = '', state = '', exitCode = '', hash = ''] = line.split('\t');
    return { service, state, exitCode, hash };
  });
}

async function containersState(ctx: ComposeContext, compose: ComposeProject): Promise<StepState> {
  const [wanted, found] = await Promise.all([configured(ctx, compose), containers(ctx, compose)]);
  for (const [service, hash] of wanted) {
    const own = found.filter((container) => container.service === service);
    if (own.length === 0) return { done: false, why: `${service} has no container` };
    const stopped = own.find((container) => container.state !== 'running');
    if (stopped) return { done: false, why: ENDED_FOR_GOOD.has(stopped.state) ? `${service} exited with ${stopped.exitCode}` : `${service} is ${stopped.state}` };
    if (own.some((container) => container.hash !== hash)) return { done: false, why: `${service} runs with settings older than its compose file's` };
  }
  return { done: true };
}

async function answered(service: ComposeService): Promise<StepState> {
  try {
    return await service.answers();
  } catch (err) {
    const failure = failureOf(err);
    if (failure.kind === 'final') throw new Hopeless(failure.reason, { cause: err });
    return { done: false, why: `it does not answer: ${failure.reason}` };
  }
}

async function stateOf(ctx: ComposeContext, service: ComposeService): Promise<StepState> {
  const running = await containersState(ctx, service.compose);
  return running.done ? answered(service) : running;
}

async function endedForGood(ctx: ComposeContext, compose: ComposeProject, progress: Progress): Promise<string | undefined> {
  const [wanted, found] = await Promise.all([configured(ctx, compose), containers(ctx, compose)]);
  for (const service of wanted.keys()) {
    const own = found.filter((container) => container.service === service);
    if (own.length === 0) return `${service} has no container after it was started`;
    const ended = own.find((container) => ENDED_FOR_GOOD.has(container.state));
    if (ended) {
      await ctx.commands.run(composeCommand(compose, ['logs', '--no-color', '--tail', String(LOG_LINES), service]), progress);
      return `${service} exited with ${ended.exitCode}`;
    }
  }
  return undefined;
}

export function composeStep(service: ComposeService): Step<ComposeContext> {
  return {
    id: service.id,
    title: service.title,
    check: (ctx) => stateOf(ctx, service),
    async apply(ctx, progress) {
      const running = await containersState(ctx, service.compose);
      const again: string[] = [];
      if (running.done) {
        const answer = await answered(service);
        if (!answer.done) {
          progress.line(`${service.title} runs with the compose file's settings but does not answer (${answer.why.replace(/^it does not answer: /, '')}), so its containers are made again`);
          again.push('--force-recreate');
        }
      }
      await ctx.commands.run(composeCommand(service.compose, ['up', '-d', ...again]), progress);
      await waitUntil(
        `${service.title} to answer`,
        async () => {
          const state = await stateOf(ctx, service);
          if (!state.done) throw stillDown(state.why);
          return true;
        },
        () => endedForGood(ctx, service.compose, progress),
        ctx.wait,
      );
    },
  };
}
