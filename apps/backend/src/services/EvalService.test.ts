import { describe, it, expect, vi } from 'vitest';
import { EvalService } from './EvalService.js';
import { BUILDER_TOOLS } from '../engine/builder-tools-catalogue.js';
import type { EvalCase } from '../engine/eval/cases.js';
import type { EvalPorts } from '../engine/eval/run.js';
import type { ModelCallOutcome, RunEnvironment } from '../engine/temporal/contracts.js';

const CASES: EvalCase[] = [
  {
    name: 'reads',
    category: 'simple',
    agent: 'agent-builder',
    say: 'show me research',
    expect: { tool: 'read_agent' },
  },
  {
    name: 'says-nothing',
    category: 'irrelevance',
    agent: 'agent-builder',
    say: 'what is an agent?',
    expect: { tool: null },
  },
];

const answered: ModelCallOutcome = {
  toolCalls: [], content: 'an agent is a who', thinking: '', finishReason: 'stop',
};

const readCall: ModelCallOutcome = {
  toolCalls: [{ id: 'c1', name: 'read_agent', arguments: '{"agent":"research"}' }],
  content: '', thinking: '', finishReason: 'stop',
};

function service(over: Partial<EvalPorts> = {}, cases = CASES) {
  const ports: EvalPorts = {
    call: vi.fn(async (args) => (args.messages[0]?.content.includes('what is') ? answered : readCall)),
    environment: vi.fn(async (): Promise<RunEnvironment> => ({ kind: 'none', egress: false })),
    catalogue: vi.fn(async () => [...BUILDER_TOOLS]),
    ...over,
  };

  return { ports, evals: new EvalService({ ports, cases, catalogue: BUILDER_TOOLS }) };
}

const settle = async (evals: EvalService, ownerId: string, id: string) => {
  for (let tick = 0; tick < 200; tick += 1) {
    const run = evals.get(ownerId, id);
    if (run && run.state !== 'running') return run;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error('the run never settled');
};

describe('running a suite', () => {
  it('starts running straight away and reports progress while it goes', async () => {
    const { evals } = service();
    const started = evals.start({ ownerId: 'user-1', repeats: 1 });

    expect(started.state).toBe('running');
    expect(started.total).toBe(2);
    expect(started.finished).toBe(0);

    const done = await settle(evals, 'user-1', started.id);
    expect(done.state).toBe('done');
    expect(done.finished).toBe(2);
  });

  it('scores each case and reports reliability at the end', async () => {
    const { evals } = service();
    const run = await settle(evals, 'user-1', evals.start({ ownerId: 'user-1', repeats: 3 }).id);

    expect(run.outcomes.map((outcome) => outcome.name)).toEqual(['reads', 'says-nothing']);
    expect(run.outcomes.every((outcome) => outcome.passed === 3)).toBe(true);
    expect(run.reliability).toMatchObject({ cases: 2, always: 2, never: 0, flaky: 0 });
  });

  it('records the complaint when the model does the wrong thing', async () => {
    const { evals } = service({ call: vi.fn(async () => answered) });
    const run = await settle(evals, 'user-1', evals.start({ ownerId: 'user-1', repeats: 2 }).id);

    const reads = run.outcomes.find((outcome) => outcome.name === 'reads')!;
    expect(reads.passed).toBe(0);
    expect(reads.complaints[0]).toContain('called no tool, answered instead');
    expect(run.reliability).toMatchObject({ always: 1, never: 1 });
  });

  it('runs only the cases it was asked for', async () => {
    const { evals } = service();
    const run = await settle(
      evals,
      'user-1',
      evals.start({ ownerId: 'user-1', repeats: 1, only: ['says-nothing'] }).id,
    );

    expect(run.total).toBe(1);
    expect(run.outcomes.map((outcome) => outcome.name)).toEqual(['says-nothing']);
  });

  it('survives a port that throws, rather than losing the whole run', async () => {
    const { evals } = service({ call: vi.fn(async () => { throw new Error('tabby is down'); }) });
    const run = await settle(evals, 'user-1', evals.start({ ownerId: 'user-1', repeats: 1 }).id);

    expect(run.state).toBe('done');
    expect(run.outcomes[0]?.complaints[0]).toContain('tabby is down');
  });
});

describe('who can see what', () => {
  it('never shows a run to anyone but its owner', async () => {
    const { evals } = service();
    const started = evals.start({ ownerId: 'user-1', repeats: 1 });

    expect(evals.get('user-2', started.id)).toBeUndefined();
    expect(evals.list('user-2')).toEqual([]);
    expect(evals.list('user-1').map((run) => run.id)).toEqual([started.id]);
  });

  it('will not let anyone else cancel it', async () => {
    const { evals } = service();
    const started = evals.start({ ownerId: 'user-1', repeats: 1 });

    expect(evals.cancel('user-2', started.id)).toBe(false);
    await settle(evals, 'user-1', started.id);
  });
});

describe('stopping', () => {
  it('stops between cases and says it was cancelled', async () => {
    const slow = vi.fn(async () => {
      await new Promise((done) => setTimeout(done, 20));
      return readCall;
    });

    const { evals } = service({ call: slow });
    const started = evals.start({ ownerId: 'user-1', repeats: 2 });

    expect(evals.cancel('user-1', started.id)).toBe(true);

    const run = await settle(evals, 'user-1', started.id);
    expect(run.state).toBe('cancelled');
    expect(run.finished).toBeLessThan(run.total);
  });

  it('refuses to cancel a run that already finished', async () => {
    const { evals } = service();
    const started = evals.start({ ownerId: 'user-1', repeats: 1 });
    await settle(evals, 'user-1', started.id);

    expect(evals.cancel('user-1', started.id)).toBe(false);
  });
});

describe('coverage', () => {
  it('reports what the suite does not check, from the catalogue itself', () => {
    const { evals } = service();
    const gaps = evals.coverage().map((gap) => gap.message);

    expect(gaps.join(' ')).toContain('nothing provokes');
    expect(gaps.join(' ')).toContain('has no case that calls compile_agent');
  });
});
