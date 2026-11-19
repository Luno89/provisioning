import { describe, expect, it } from 'vitest';
import { fakeCommands, type Answer } from '../testing/fake-commands.js';
import { memoryReporter } from '../testing/memory-reporter.js';
import type { Command } from './commands.js';
import { composeStep, type ComposeProject } from './compose.js';
import { runSteps, type StepState } from './steps.js';
import { stepFailureOf } from '../testing/step-failure.js';
import type { WaitOptions } from './wait-until.js';

const PROJECT: ComposeProject = { program: ['docker', 'compose'], files: ['/repo/docker-compose.mongo.yml'], project: 'koala-test' };
const instant: WaitOptions = { pause: async () => undefined };
const BASE = ['compose', '-p', 'koala-test', '-f', '/repo/docker-compose.mongo.yml'];

interface Container { state: string; exitCode?: number; hash: string }

interface Host {
  configured: Record<string, string>;
  containers: Record<string, Container>;
  logs?: string;
  upFails?: boolean;
  afterUp?: (host: Host, args: readonly string[]) => void;
  onPs?: (host: Host) => void;
}

const said = (command: Command): string[] => (command.args ?? []).slice(BASE.length);

const docker = (host: Host) => fakeCommands((command): Answer | undefined => {
  if (command.command !== 'docker' || JSON.stringify((command.args ?? []).slice(0, BASE.length)) !== JSON.stringify(BASE)) return undefined;
  const [verb, ...rest] = (command.args ?? []).slice(BASE.length);
  if (verb === 'config') return { stdout: Object.entries(host.configured).map(([service, hash]) => `${service} ${hash}\n`).join('') };
  if (verb === 'ps') host.onPs?.(host);
  if (verb === 'ps') return { stdout: Object.entries(host.containers).map(([service, c]) => `${service}\t${c.state}\t${c.exitCode ?? 0}\t${c.hash}\n`).join('') };
  if (verb === 'up') {
    if (host.upFails) return { code: 1, stderr: 'Error response from daemon: port is already allocated\n' };
    host.afterUp?.(host, rest);
    return { stderr: ' Container koala-test-mongodb-1  Started\n' };
  }
  if (verb === 'logs') return { stdout: host.logs ?? '' };
  return undefined;
});

const verbs = (ran: Command[]): string[] => ran.map((command) => said(command).join(' '));

const answering = (answers: StepState[]): (() => Promise<StepState>) => async () => answers.shift() ?? { done: true };

describe('a service started through its compose file', () => {
  it('is left alone when every service runs with the compose file\'s settings and answers', async () => {
    const commands = docker({ configured: { mongodb: 'h1' }, containers: { mongodb: { state: 'running', hash: 'h1' } } });
    const reporter = memoryReporter();
    await runSteps([composeStep({ id: 'mongo', title: 'Mongo', compose: PROJECT, answers: answering([{ done: true }]) })], { commands, wait: instant }, reporter);
    expect(reporter.reported.map((entry) => entry.kind)).toEqual(['started', 'already-done']);
    expect(verbs(commands.ran)).not.toContain('up -d');
  });

  it('is started when it has no container, and is done once it answers', async () => {
    const host: Host = { configured: { mongodb: 'h1' }, containers: {}, afterUp: (h) => { h.containers['mongodb'] = { state: 'running', hash: 'h1' }; } };
    const commands = docker(host);
    const reporter = memoryReporter();
    const answers = answering([{ done: false, why: 'not a replica set member yet' }, { done: true }, { done: true }]);
    await runSteps([composeStep({ id: 'mongo', title: 'Mongo', compose: PROJECT, answers })], { commands, wait: instant }, reporter);
    expect(verbs(commands.ran)).toContain('up -d');
    expect(reporter.reported.at(-1)).toEqual({ kind: 'done', id: 'mongo' });
    expect(reporter.linesOf('mongo')).toContain(' Container koala-test-mongodb-1  Started');
  });

  it('waits through a refused connection while it comes up, as a dependency that is not there yet', async () => {
    const host: Host = { configured: { mongodb: 'h1' }, containers: {}, afterUp: (h) => { h.containers['mongodb'] = { state: 'running', hash: 'h1' }; } };
    let asked = 0;
    const answers = async (): Promise<StepState> => {
      asked += 1;
      if (asked < 3) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      return { done: true };
    };
    await runSteps([composeStep({ id: 'mongo', title: 'Mongo', compose: PROJECT, answers })], { commands: docker(host), wait: instant }, memoryReporter());
    expect(asked).toBeGreaterThanOrEqual(3);
  });

  it('waits through a connection that does not open yet while it starts, saying what the connection said, and ends answered', async () => {
    const host: Host = { configured: { temporal: 't' }, containers: {}, afterUp: (h) => { h.containers['temporal'] = { state: 'running', hash: 't' }; } };
    const waited: string[] = [];
    let asked = 0;
    const answers = async (): Promise<StepState> => {
      asked += 1;
      if (asked <= 12) throw new Error('Failed to connect before the deadline');
      return { done: true };
    };
    const reporter = memoryReporter();
    await runSteps([composeStep({ id: 'temporal', title: 'Temporal', compose: PROJECT, answers })], { commands: docker(host), wait: { ...instant, waiting: (_what, last) => { waited.push(last); } } }, reporter);
    expect(asked).toBeGreaterThan(12);
    expect(reporter.reported.at(-1)).toEqual({ kind: 'done', id: 'temporal' });
    expect(waited[0]).toContain('Failed to connect before the deadline');
  });

  it('fails with the exit and the log tail when its container exits while its connection never opened', async () => {
    let asked = 0;
    const host: Host = {
      configured: { temporal: 't' },
      containers: {},
      logs: 'temporal-1  | unable to start: listen tcp :7233: bind: address already in use\n',
      afterUp: (h) => { h.containers['temporal'] = { state: 'running', hash: 't' }; },
      onPs: (h) => { if (asked === 3) h.containers['temporal'] = { state: 'exited', exitCode: 1, hash: 't' }; },
    };
    const answers = async (): Promise<StepState> => {
      asked += 1;
      throw new Error('Failed to connect before the deadline');
    };
    const commands = docker(host);
    const failure = await stepFailureOf(runSteps([composeStep({ id: 'temporal', title: 'Temporal', compose: PROJECT, answers })], { commands, wait: instant }, memoryReporter()));
    expect(failure.why).toContain('Temporal to answer: temporal exited with 1');
    expect(failure.tail).toContain('temporal-1  | unable to start: listen tcp :7233: bind: address already in use');
    expect(asked).toBe(3);
  });

  it('is started again with its new settings when its container runs with older ones', async () => {
    const host: Host = { configured: { mongodb: 'new' }, containers: { mongodb: { state: 'running', hash: 'old' } }, afterUp: (h) => { h.containers['mongodb'] = { state: 'running', hash: 'new' }; } };
    const commands = docker(host);
    const reporter = memoryReporter();
    await runSteps([composeStep({ id: 'mongo', title: 'Mongo', compose: PROJECT, answers: answering([]) })], { commands, wait: instant }, reporter);
    expect(verbs(commands.ran)).toContain('up -d');
    expect(reporter.reported.at(-1)).toEqual({ kind: 'done', id: 'mongo' });
  });

  it('is made again when it runs as configured but does not answer, rather than waited on unchanged', async () => {
    const host: Host = { configured: { mongodb: 'h1' }, containers: { mongodb: { state: 'running', hash: 'h1' } } };
    const commands = docker(host);
    const reporter = memoryReporter();
    await runSteps([composeStep({ id: 'mongo', title: 'Mongo', compose: PROJECT, answers: answering([{ done: false, why: 'its certificate is not the one its CA signed' }, { done: false, why: 'its certificate is not the one its CA signed' }]) })], { commands, wait: instant }, reporter);
    expect(verbs(commands.ran)).toContain('up -d --force-recreate');
    expect(reporter.linesOf('mongo')[0]).toBe('Mongo runs with the compose file\'s settings but does not answer (its certificate is not the one its CA signed), so its containers are made again');
  });

  it('fails with the exit and the log tail of a container that exited for good, never waiting on it', async () => {
    const host: Host = {
      configured: { postgresql: 'p', temporal: 't' },
      containers: { postgresql: { state: 'running', hash: 'p' } },
      logs: 'temporal-1  | unable to start: sql schema version compatibility check failed\n',
      afterUp: (h) => { h.containers['temporal'] = { state: 'exited', exitCode: 1, hash: 't' }; },
    };
    const commands = docker(host);
    const failure = await stepFailureOf(runSteps([composeStep({ id: 'temporal', title: 'Temporal', compose: PROJECT, answers: answering([]) })], { commands, wait: instant }, memoryReporter()));
    expect(failure.why).toContain('Temporal to answer: temporal exited with 1');
    expect(failure.tail).toContain('temporal-1  | unable to start: sql schema version compatibility check failed');
    expect(verbs(commands.ran)).toContain('logs --no-color --tail 40 temporal');
  });

  it('keeps waiting while a container is restarting, which Docker does on its own', async () => {
    let listed = 0;
    const host: Host = {
      configured: { mongodb: 'h1' },
      containers: {},
      afterUp: (h) => { h.containers['mongodb'] = { state: 'restarting', exitCode: 1, hash: 'h1' }; },
      onPs: (h) => {
        listed += 1;
        if (listed === 5) h.containers['mongodb'] = { state: 'running', hash: 'h1' };
      },
    };
    const reporter = memoryReporter();
    await runSteps([composeStep({ id: 'mongo', title: 'Mongo', compose: PROJECT, answers: answering([]) })], { commands: docker(host), wait: instant }, reporter);
    expect(listed).toBeGreaterThanOrEqual(5);
    expect(reporter.reported.at(-1)).toEqual({ kind: 'done', id: 'mongo' });
  });

  it('fails at once on an answer that says it can never come, with that reason', async () => {
    const host: Host = { configured: { mongodb: 'h1' }, containers: {}, afterUp: (h) => { h.containers['mongodb'] = { state: 'running', hash: 'h1' }; } };
    let asked = 0;
    const answers = async (): Promise<StepState> => {
      asked += 1;
      throw Object.assign(new Error('Authentication failed'), { response: { status: 401 } });
    };
    const failure = await stepFailureOf(runSteps([composeStep({ id: 'mongo', title: 'Mongo', compose: PROJECT, answers })], { commands: docker(host), wait: instant }, memoryReporter()));
    expect(failure.why).toContain('it refused the request (401)');
    expect(asked).toBe(1);
  });

  it('fails with compose\'s own words when compose cannot start it', async () => {
    const failure = await stepFailureOf(runSteps([composeStep({ id: 'mongo', title: 'Mongo', compose: PROJECT, answers: answering([]) })], { commands: docker({ configured: { mongodb: 'h1' }, containers: {}, upFails: true }), wait: instant }, memoryReporter()));
    expect(failure.why).toContain('up -d exited with 1');
    expect(failure.tail).toContain('Error response from daemon: port is already allocated');
  });

  it('runs compose as the program it was given, without a project name when none is given', async () => {
    const commands = fakeCommands((command) => {
      if (command.command !== '/repo/bin/docker-compose') return undefined;
      const args = command.args ?? [];
      if (args.includes('config')) return { stdout: 'headscale h\n' };
      if (args.includes('ps')) return { stdout: 'headscale\trunning\t0\th\n' };
      return undefined;
    });
    await runSteps([composeStep({ id: 'headscale', title: 'Headscale', compose: { program: ['/repo/bin/docker-compose'], files: ['/repo/docker-compose.headscale.yml'] }, answers: answering([]) })], { commands, wait: instant }, memoryReporter());
    expect(commands.ran[0]).toMatchObject({ command: '/repo/bin/docker-compose', args: ['-f', '/repo/docker-compose.headscale.yml', 'config', '--hash', '*'] });
  });
});
