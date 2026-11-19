import { connect, createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryReporter } from '../testing/memory-reporter.js';
import { processProvider } from './process.js';
import { serviceStep } from './service.js';
import { removeSteps, runSteps, StepFailed, type Step } from './steps.js';

const ctx = {};
const made: Step<object>[] = [];
afterEach(async () => { await removeSteps(made.splice(0), ctx, memoryReporter()); });

const freePort = (): Promise<number> => new Promise((done) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => done(port));
  });
});

const answering = (port: number) => async () => {
  await new Promise<void>((done, refused) => {
    const client = connect(port, '127.0.0.1', () => { client.destroy(); done(); });
    client.once('error', refused);
  });
  return { done: true } as const;
};

describe('a service that is a process of this run', () => {
  it('is started, answers, and its removal stops it and waits for it to end', async () => {
    const port = await freePort();
    const provider = processProvider({ name: 'listener', command: process.execPath, args: ['-e', `require('node:net').createServer().listen(${port}, '127.0.0.1')`] });
    const step = serviceStep({ id: 'listener', title: 'A listener', provider, answers: answering(port) });
    made.push(step);
    await runSteps([step], ctx, memoryReporter());
    const pid = provider.pid();
    expect(() => process.kill(pid, 0)).not.toThrow();
    await removeSteps([step], ctx, memoryReporter());
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('fails as soon as the process exits, with its code and the last it said, even while its answer is still awaited', async () => {
    const provider = processProvider({ name: 'listener', command: process.execPath, args: ['-e', 'setTimeout(() => { console.error("address already in use"); process.exit(48); }, 1500)'] });
    const step = serviceStep({ id: 'listener', title: 'A listener', provider, answers: () => new Promise(() => undefined) });
    made.push(step);
    const failure: unknown = await runSteps([step], ctx, memoryReporter()).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(StepFailed);
    expect((failure as StepFailed).why).toMatch(/^A listener to answer: listener exited with 48 \(last said: address already in use\)/);
  });
});
