import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { throwawayLabel } from '@koala/engine-core/testing/throwaway-containers';
import { memoryReporter } from '../testing/memory-reporter.js';
import { containerProvider, type ContainerProvider } from './container.js';
import { localCommands } from './local-commands.js';
import { serviceStep } from './service.js';
import { removeSteps, runSteps, StepFailed, type Step } from './steps.js';

const IMAGE = 'alpine:3.20';
const ctx = { commands: localCommands(process.env) };
const quiet = { line: () => undefined };
const made: Step<typeof ctx>[] = [];
afterEach(async () => { await removeSteps(made.splice(0), ctx, memoryReporter()); });

const docker = async (...args: string[]) => (await ctx.commands.run({ command: 'docker', args, accept: [0, 1] }, quiet)).stdout.trim();

function served(command: readonly string[]): { container: ContainerProvider; step: Step<typeof ctx> } {
  const container = containerProvider({ name: `koala-container-${randomUUID().slice(0, 8)}`, image: IMAGE, run: [...throwawayLabel(), '-p', '127.0.0.1::8080'], command, publish: [8080] });
  const step = serviceStep({
    id: 'web',
    title: 'A web server',
    provider: container,
    answers: async () => {
      await fetch(`http://127.0.0.1:${container.published(8080)}/`);
      return { done: true };
    },
  });
  made.push(step);
  return { container, step };
}

const HTTPD = ['sh', '-c', 'while true; do printf "HTTP/1.0 200 OK\\r\\n\\r\\nok" | nc -l -p 8080; done'];

describe('a service that is a container of this run', () => {
  it('is run, answers on the port it publishes, and its removal takes the container away', async () => {
    const { container, step } = served(HTTPD);
    await runSteps([step], ctx, memoryReporter());
    expect(container.published(8080)).toBeGreaterThan(0);
    expect(await docker('inspect', '-f', '{{.State.Status}}', container.name)).toBe('running');
    await removeSteps([step], ctx, memoryReporter());
    expect(await docker('ps', '-a', '--filter', `name=^${container.name}$`, '--format', '{{.Names}}')).toBe('');
  });

  it('starts the same container again once it was stopped, keeping what it holds', async () => {
    const { container, step } = served(HTTPD);
    await runSteps([step], ctx, memoryReporter());
    const id = await docker('inspect', '-f', '{{.Id}}', container.name);
    await docker('stop', container.name);
    const reporter = memoryReporter();
    await runSteps([step], ctx, reporter);
    expect(reporter.reported.filter((entry) => entry.kind !== 'line').map((entry) => entry.kind)).toEqual(['started', 'done']);
    expect(await docker('inspect', '-f', '{{.Id}}', container.name)).toBe(id);
  });

  it('fails once the container exits, with its code and the last it said', async () => {
    const { step } = served(['sh', '-c', 'echo the data folder is not writable; exit 3']);
    const failure: unknown = await runSteps([step], ctx, memoryReporter()).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(StepFailed);
    expect((failure as StepFailed).why).toMatch(/^A web server to answer: koala-container-\w+ exited with 3/);
    expect((failure as StepFailed).tail).toContain('the data folder is not writable');
  });
});
