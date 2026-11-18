import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { portToHandOn } from '@koala/engine-core/testing/ports';
import { memoryReporter } from '../testing/memory-reporter.js';
import { composeCommand, composeStep, type ComposeProject } from './compose.js';
import { localCommands } from './local-commands.js';
import { runSteps, StepFailed, type StepState } from './steps.js';

const COMPOSE = resolve(import.meta.dirname, '../../../bin/docker-compose');
const commands = localCommands(process.env);
const quiet = { line: () => undefined };
const made: { compose: ComposeProject; folder: string }[] = [];

afterEach(async () => {
  for (const { compose, folder } of made.splice(0)) {
    await commands.run(composeCommand(compose, ['down', '-v', '--remove-orphans']), quiet);
    rmSync(folder, { recursive: true, force: true });
  }
});

function project(services: string): ComposeProject {
  const folder = mkdtempSync(join(tmpdir(), 'koala-compose-'));
  const file = join(folder, 'compose.yml');
  writeFileSync(file, `services:\n${services}`);
  const compose: ComposeProject = { program: [COMPOSE], files: [file], project: `koala-provision-${randomUUID().slice(0, 8)}` };
  made.push({ compose, folder });
  return compose;
}

const served = (port: number, said = 'up'): string => [
  '  web:',
  '    image: busybox:1.37',
  '    restart: unless-stopped',
  '    init: true',
  `    command: ["sh", "-c", "mkdir -p /www && echo ${said} > /www/index.html && exec httpd -f -p 8080 -h /www"]`,
  `    ports: ["127.0.0.1:${port}:8080"]`,
  '',
].join('\n');

const answersOn = (port: number, expected = 'up') => async (): Promise<StepState> => {
  const body = (await (await fetch(`http://127.0.0.1:${port}/`)).text()).trim();
  return body === expected ? { done: true } : { done: false, why: `it serves ${body}` };
};

describe('a service started through its compose file, on this computer\'s Docker', () => {
  it('is started and waited on until it answers, and is left alone the next time', async () => {
    const port = await portToHandOn();
    const compose = project(served(port));
    const step = composeStep({ id: 'web', title: 'The web server', compose, answers: answersOn(port) });
    const first = memoryReporter();
    await runSteps([step], { commands }, first);
    expect(first.reported.at(-1)).toEqual({ kind: 'done', id: 'web' });
    const second = memoryReporter();
    await runSteps([step], { commands }, second);
    expect(second.reported.map((entry) => entry.kind)).toEqual(['started', 'already-done']);
  });

  it('is made again with the compose file\'s new settings', async () => {
    const port = await portToHandOn();
    const compose = project(served(port, 'before'));
    await runSteps([composeStep({ id: 'web', title: 'The web server', compose, answers: answersOn(port, 'before') })], { commands }, memoryReporter());
    writeFileSync(compose.files[0]!, `services:\n${served(port, 'after')}`);
    const reporter = memoryReporter();
    await runSteps([composeStep({ id: 'web', title: 'The web server', compose, answers: answersOn(port, 'after') })], { commands }, reporter);
    expect(reporter.reported.at(-1)).toEqual({ kind: 'done', id: 'web' });
    expect(await answersOn(port, 'after')()).toEqual({ done: true });
  });

  it('fails with the exit and the log tail of a container that exited, without waiting on it', async () => {
    const compose = project([
      '  broken:',
      '    image: busybox:1.37',
      '    command: ["sh", "-c", "echo the schema is too new for this server; exit 3"]',
      '',
    ].join('\n'));
    const err: unknown = await runSteps([composeStep({ id: 'broken', title: 'The broken server', compose, answers: async () => ({ done: false, why: 'nothing answers' }) })], { commands }, memoryReporter()).then(() => undefined, (thrown: unknown) => thrown);
    expect(err).toBeInstanceOf(StepFailed);
    expect((err as StepFailed).why).toContain('broken exited with 3');
    expect((err as StepFailed).tail.join('\n')).toContain('the schema is too new for this server');
  });
});
