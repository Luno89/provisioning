import { describe, expect, it } from 'vitest';
import { createNodeCatalogue, defineNode } from '../definition.js';
import { runProcedure, type StepResult } from '../interpreter.js';
import { checkProcedure } from '../validate.js';
import { flow, node, procedure, scriptedExecutor, TEST_NODES } from '../../../testing/procedure-nodes.js';
import { together } from './together.js';

const pieceNode = defineNode({
  kind: 'piece',
  title: 'Piece',
  category: 'control',
  describe: 'Comes up or fails',
  role: 'step',
  inputs: [],
  outputs: [{ name: 'reason', type: 'text', describe: 'Why it failed' }],
  exits: [
    { name: 'done', describe: 'It came up' },
    { name: 'failed', describe: 'It did not' },
  ],
  settings: { type: 'object', properties: {} },
  runs: 'activity',
  idempotent: true,
  summarize: () => 'a piece',
});

const catalogue = () => createNodeCatalogue([...TEST_NODES, pieceNode, together.definition]);

const identity = { runId: 'run-1', depth: 0, agentId: 'tester', loopId: 'test', loopVersion: '1', trigger: 'user' as const };

const branches = (entries: Array<[string, string[]?]>) => ({ branches: entries.map(([name, after]) => ({ node: name, ...(after ? { after } : {}) })) });

const subject = (entries: Array<[string, string[]?]>) => procedure({
  start: 'all',
  nodes: [
    node('all', 'together', branches(entries)),
    ...entries.map(([name]) => node(name, 'piece', {}, { label: `Piece ${name}` })),
    node('up', 'finish', { outcome: 'ok' }),
    node('down', 'finish', { outcome: 'failed' }),
  ],
  flow: [flow('all:done', 'up'), flow('all:failed', 'down')],
});

interface Held {
  started: string[];
  release(name: string, result: StepResult): void;
}

function held(): Held & { step: (request: { node: { id: string } }) => Promise<StepResult> } {
  const waiting = new Map<string, (result: StepResult) => void>();
  const early = new Map<string, StepResult>();
  const started: string[] = [];
  return {
    started,
    release(name, result) {
      const resolve = waiting.get(name);
      if (resolve) resolve(result);
      else early.set(name, result);
    },
    step: ({ node: placed }) => {
      started.push(placed.id);
      const ready = early.get(placed.id);
      return ready ? Promise.resolve(ready) : new Promise((resolve) => { waiting.set(placed.id, resolve); });
    },
  };
}

const settle = () => new Promise((resolve) => { setImmediate(resolve); });

const run = (shape: ReturnType<typeof subject>, step: (request: { node: { id: string } }) => Promise<StepResult>) => {
  const executor = scriptedExecutor({ together: together.implementation!.run as never, piece: step as never });
  return runProcedure({ procedure: shape, catalogue: catalogue(), executor, identity, launch: { ownerId: 'owner-1' } });
};

describe('running steps together', () => {
  it('starts every branch that waits on nothing at once', async () => {
    const pieces = held();
    const ran = run(subject([['a'], ['b'], ['c']]), pieces.step);
    await settle();

    expect(pieces.started).toEqual(['a', 'b', 'c']);
    for (const name of ['a', 'b', 'c']) pieces.release(name, { exit: 'done' });
    expect(await ran).toMatchObject({ outcome: 'ok', finishedBy: 'up' });
  });

  it('starts a branch only once the branches it waits on are done', async () => {
    const pieces = held();
    const ran = run(subject([['a'], ['b', ['a']], ['c']]), pieces.step);
    await settle();

    expect(pieces.started).toEqual(['a', 'c']);
    pieces.release('a', { exit: 'done' });
    await settle();
    expect(pieces.started).toEqual(['a', 'c', 'b']);
    pieces.release('b', { exit: 'done' });
    pieces.release('c', { exit: 'done' });
    expect(await ran).toMatchObject({ outcome: 'ok' });
  });

  it('runs every other branch to its end when one fails, and names every one that did not come up', async () => {
    const pieces = held();
    const ran = run(subject([['a'], ['b'], ['c'], ['d', ['a']]]), pieces.step);
    await settle();
    pieces.release('a', { exit: 'failed', outputs: { reason: 'its image could not be pulled' } });
    await settle();
    pieces.release('b', { exit: 'failed', outputs: { reason: 'its volume never bound' } });
    pieces.release('c', { exit: 'done' });
    const result = await ran;

    expect(pieces.started).toEqual(['a', 'b', 'c']);
    expect(result).toMatchObject({ outcome: 'failed', finishedBy: 'down' });
    expect(result.outputs.all).toEqual({
      failed: [
        { branch: 'a', title: 'Piece a', why: 'its image could not be pulled' },
        { branch: 'b', title: 'Piece b', why: 'its volume never bound' },
        { branch: 'd', title: 'Piece d', why: 'it did not start, since Piece a did not come up' },
      ],
      reason: 'Piece a: its image could not be pulled; Piece b: its volume never bound; Piece d: it did not start, since Piece a did not come up',
    });
  });

  it('names a branch whose step broke as failed, with why', async () => {
    const result = await run(subject([['a'], ['b']]), async ({ node: placed }) => {
      if (placed.id === 'a') throw new Error('the worker went away');
      return { exit: 'done' };
    });

    expect(result.outputs.all).toMatchObject({ reason: 'Piece a: the worker went away' });
  });
});

describe('checking steps run together', () => {
  const problems = (shape: ReturnType<typeof subject>) => checkProcedure(shape, { catalogue: catalogue() }).filter((problem) => problem.severity === 'error');

  it('takes a branch step that leads nowhere, since it ends where its branch does', () => {
    expect(problems(subject([['a'], ['b', ['a']]]))).toEqual([]);
  });

  it('refuses a branch something flows into or out of, a branch that is not a step here, and branches that wait in a circle', () => {
    const shape = subject([['a', ['b']], ['b', ['a']]]);
    const broken = { ...shape, nodes: [...shape.nodes, node('stray', 'piece')], flow: [...shape.flow, flow('a:done', 'stray'), flow('stray:done', 'b'), flow('stray:failed', 'down')] };
    const missing = subject([['a']]);

    expect(problems(broken).map((problem) => problem.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('wait on each other in a circle'),
      expect.stringContaining('runs alongside "all", so nothing follows it'),
      expect.stringContaining('runs alongside "all", so nothing leads to it'),
    ]));
    expect(problems({ ...missing, nodes: missing.nodes.filter((placed) => placed.id !== 'a') }).map((problem) => problem.message))
      .toContain('runs "a" alongside, which is not a step here');
  });
});
