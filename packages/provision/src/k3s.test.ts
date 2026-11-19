import { describe, expect, it } from 'vitest';
import { memoryReporter } from '../testing/memory-reporter.js';
import { expectReadyOnlySinceStart } from '../testing/ready-since.js';
import { k3sAnswers, k3sStep, readySince } from './k3s.js';
import type { Provider } from './service.js';
import { runSteps, StepFailed } from './steps.js';

const START = Date.parse('2026-11-05T10:00:00Z');
const at = (ms: number) => new Date(ms).toISOString();

const answering = (answers: string[]) => async (args: readonly string[]) => {
  const next = answers.shift();
  if (next === undefined) throw new Error(`asked ${args.join(' ')} once too often`);
  if (next === 'refused') throw new Error('The connection to the server 127.0.0.1:6443 was refused');
  return next;
};

describe('k3s, ready', () => {
  it('once its node and its DNS turned Ready since it started', async () => {
    expect(await k3sAnswers(answering([`True ${at(START + 1)}`, `True ${at(START + 2)}`]), () => START)()).toEqual({ done: true });
  });

  it('not yet while either turned Ready only before this start, saying which', async () => {
    expect(await k3sAnswers(answering([`True ${at(START - 1)}`, `True ${at(START + 2)}`]), () => START)()).toEqual({ done: false, why: 'its node has not turned Ready since it started' });
    expect(await k3sAnswers(answering([`True ${at(START + 1)}`, `False ${at(START + 2)}`]), () => START)()).toEqual({ done: false, why: 'its DNS has not turned Ready since it started' });
  });

  it('not yet while its API refuses kubectl, which is what starting looks like', async () => {
    expect(await k3sAnswers(answering(['refused']), () => START)()).toEqual({ done: false, why: 'its API refuses kubectl while it starts: The connection to the server 127.0.0.1:6443 was refused' });
  });

  it('judges readiness only from a transition since the start', () => {
    expectReadyOnlySinceStart(readySince);
  });

  it('is waited on until its provider says it ended for good, and then fails with why', async () => {
    let started = false;
    const provider: Provider<object> = {
      running: async () => (started ? { done: true } : { done: false, why: 'k3s is stopped' }),
      start: async () => { started = true; },
      ended: async () => 'k3s stopped while it started: no space left',
    };
    const failure: unknown = await runSteps([k3sStep(provider, answering(['refused', 'refused']), () => START)], { wait: { pause: async () => undefined } }, memoryReporter()).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(StepFailed);
    expect((failure as StepFailed).why).toMatch(/^k3s, its node and DNS ready, to answer: k3s stopped while it started: no space left/);
  });
});
