import { describe, it, expect } from 'vitest';
import {
  buildTaskAuthorPrompt,
  extractTaskProposals,
  stripTaskBlock,
  judgeEmptyRun,
  judgeSolutionRun,
  selfProvisionedInputs,
  buildTaskChatPrompt,
  extractTaskRevision,
} from './experiment-authoring.js';
import { MAX_TASKS, MAX_TASK_CHARS } from './experiments.js';

const block = (tasks: unknown[]) => '```json\n' + JSON.stringify({ tasks }) + '\n```';

const good = (over: Record<string, unknown> = {}) => ({
  name: 'fib',
  prompt: 'Create /work/fib.js exporting fib(n).',
  verifyCommand: 'cd /work && node test.js',
  ...over,
});

describe('buildTaskAuthorPrompt', () => {
  it('carries the real sandbox constraints, so a proposal cannot need the network', () => {
    const prompt = buildTaskAuthorPrompt();
    expect(prompt).toMatch(/NO outbound network/);
    expect(prompt).toMatch(/read-only/);
  });

  it('teaches both properties that will actually be enforced', () => {
    const prompt = buildTaskAuthorPrompt();
    expect(prompt).toMatch(/MUST FAIL with only the seed present/);
    expect(prompt).toMatch(/MUST PASS with seed \+ solution/);
    expect(prompt).toMatch(/checks the ARTEFACT|check the ARTEFACT/);
  });

  it('explains that a prompt referring to a file needs that file in the seed', () => {
    const prompt = buildTaskAuthorPrompt();
    expect(prompt).toMatch(/MUST be in the seed/);
    expect(prompt).toMatch(/never sees it/);
  });

  it('permits proposing nothing, so a vague goal does not manufacture tasks', () => {
    expect(buildTaskAuthorPrompt()).toMatch(/Propose nothing if the goal is unclear/);
  });

  it('lists the existing suite so it proposes different work', () => {
    const prompt = buildTaskAuthorPrompt({ existing: ['fib', 'parse csv'] });
    expect(prompt).toMatch(/- fib/);
    expect(prompt).toMatch(/- parse csv/);
  });

  it('offers only languages the sandbox actually has', () => {
    const prompt = buildTaskAuthorPrompt();
    expect(prompt).toMatch(/node \(/);
    expect(prompt).toMatch(/go \(/);
  });
});

describe('extractTaskProposals', () => {
  it('reads a well-formed block', () => {
    const { tasks, rejected } = extractTaskProposals(`Here you go:\n${block([good({ language: 'go' })])}`);
    expect(rejected).toEqual([]);
    expect(tasks).toEqual([{
      name: 'fib',
      prompt: 'Create /work/fib.js exporting fib(n).',
      verifyCommand: 'cd /work && node test.js',
      language: 'go',
    }]);
  });

  it('returns nothing for prose, rather than guessing', () => {
    expect(extractTaskProposals('I would start by writing some tests.').tasks).toEqual([]);
  });

  it('ignores a block that is not JSON', () => {
    expect(extractTaskProposals('```\nnot json at all\n```').tasks).toEqual([]);
  });

  it('scans every block, since the real one is not always last', () => {
    const reply = '```json\n{"example":true}\n```\ntext\n' + block([good()]);
    expect(extractTaskProposals(reply).tasks).toHaveLength(1);
  });

  it('accepts a bare object, which smaller models emit often enough to matter', () => {
    expect(extractTaskProposals(JSON.stringify({ tasks: [good()] })).tasks).toHaveLength(1);
  });

  it('drops an unknown language rather than inventing an image', () => {
    const { tasks } = extractTaskProposals(block([good({ language: 'rust' })]));
    expect(tasks[0]!.language).toBeUndefined();
  });

  it('reads a suite whose prompt contains a fenced code sample', () => {
    const withFence = good({
      prompt: 'The file contains:\n```\nfoo\nbar\n```\nEdit it to say baz.',
    });
    const reply = '```json\n' + JSON.stringify({ tasks: [withFence] }) + '\n```';
    const { tasks, rejected } = extractTaskProposals(reply);
    expect(rejected).toEqual([]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.prompt).toMatch(/foo/);
  });

  it('does not double-count a block the fallback also matches', () => {
    expect(extractTaskProposals(block([good()])).tasks).toHaveLength(1);
  });

  it('keeps the first of two proposals sharing a name', () => {
    const { tasks } = extractTaskProposals(block([
      good({ prompt: 'first' }),
      good({ prompt: 'second' }),
    ]));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.prompt).toBe('first');
  });

  it('skips a proposal with no name, which could not even be reported on', () => {
    const { tasks, rejected } = extractTaskProposals(block([good({ name: '  ' })]));
    expect(tasks).toEqual([]);
    expect(rejected).toEqual([]);
  });
});

describe('the verify command gate', () => {
  it('rejects a command that passes whatever the agent did', () => {
    for (const cmd of ['true', ':', 'exit 0', 'echo ok', 'echo PASS']) {
      const { tasks, rejected } = extractTaskProposals(block([good({ verifyCommand: cmd })]));
      expect(tasks).toEqual([]);
      expect(rejected[0]!.reason).toMatch(/passes whatever the agent did/);
    }
  });

  it('rejects a missing verify command', () => {
    const { tasks, rejected } = extractTaskProposals(block([good({ verifyCommand: '' })]));
    expect(tasks).toEqual([]);
    expect(rejected).toEqual([{ name: 'fib', reason: 'has no verify command' }]);
  });

  it('keeps a real command that merely starts with echo', () => {
    const { tasks } = extractTaskProposals(block([good({ verifyCommand: 'echo start && node t.js' })]));
    expect(tasks).toHaveLength(1);
  });

  it('reports rejections rather than silently shrinking the batch', () => {
    const { tasks, rejected } = extractTaskProposals(block([
      good({ name: 'a' }),
      good({ name: 'b', verifyCommand: 'true' }),
      good({ name: 'c', prompt: '' }),
    ]));
    expect(tasks.map((t) => t.name)).toEqual(['a']);
    expect(rejected.map((r) => r.name)).toEqual(['b', 'c']);
  });
});

describe('judgeSolutionRun', () => {
  it('accepts a command that passes on a correct answer', () => {
    expect(judgeSolutionRun({ exitCode: 0, timedOut: false })).toEqual({ ok: true });
  });

  it('rejects a command that fails even on a correct answer', () => {
    const v = judgeSolutionRun({ exitCode: 1, timedOut: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/the command is wrong, not the task/);
  });

  it('rejects a command that hangs on a correct answer', () => {
    expect(judgeSolutionRun({ exitCode: -1, timedOut: true }).reason).toMatch(/hung/);
  });
});

describe('judgeEmptyRun', () => {
  it('accepts a command that failed, which is what a real check does', () => {
    expect(judgeEmptyRun({ exitCode: 1, timedOut: false })).toEqual({ ok: true });
  });

  it('rejects a command that passed with no work done', () => {
    const v = judgeEmptyRun({ exitCode: 0, timedOut: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not checking anything/);
  });

  it('rejects a command that hung', () => {
    const v = judgeEmptyRun({ exitCode: -1, timedOut: true });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/hung/);
  });

  it('rejects a command that failed for the wrong reason', () => {
    const v = judgeEmptyRun({ exitCode: 127, timedOut: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/command not found/);
  });
});

describe('selfProvisionedInputs', () => {
  it('catches a verify command that creates the input the prompt asks the agent to read', () => {
    expect(selfProvisionedInputs(
      'Read /work/data.txt and print its contents.',
      ['data.txt', 'read.js'],
    )).toEqual(['data.txt']);
  });

  it('allows scaffolding the prompt never mentions', () => {
    expect(selfProvisionedInputs(
      'Create hello.js that prints PASS.',
      ['.verify-tmp', 'expected-output.txt'],
    )).toEqual([]);
  });

  it('matches the bare filename inside a path', () => {
    expect(selfProvisionedInputs('open /work/input.csv', ['input.csv'])).toEqual(['input.csv']);
  });

  it('does not fire on a partial word', () => {
    expect(selfProvisionedInputs('Set up the database.', ['data.txt'])).toEqual([]);
  });

  it('is quiet when the verify command creates nothing', () => {
    expect(selfProvisionedInputs('Read data.txt', [])).toEqual([]);
  });
});

describe('caps', () => {
  it('stops at the suite ceiling the create route enforces', () => {
    const many = Array.from({ length: MAX_TASKS + 5 }, (_, i) => good({ name: `t${i}` }));
    expect(extractTaskProposals(block(many)).tasks).toHaveLength(MAX_TASKS);
  });

  it('counts accepted tasks toward the ceiling, not rejected ones', () => {
    const mixed = [
      ...Array.from({ length: 4 }, (_, i) => good({ name: `bad${i}`, verifyCommand: 'true' })),
      ...Array.from({ length: MAX_TASKS }, (_, i) => good({ name: `ok${i}` })),
    ];
    const { tasks, rejected } = extractTaskProposals(block(mixed));
    expect(tasks).toHaveLength(MAX_TASKS);
    expect(rejected).toHaveLength(4);
  });

  it('truncates an overlong prompt rather than rejecting the task', () => {
    const { tasks } = extractTaskProposals(block([good({ prompt: 'x'.repeat(MAX_TASK_CHARS + 500) })]));
    expect(tasks[0]!.prompt).toHaveLength(MAX_TASK_CHARS);
  });
});

describe('stripTaskBlock', () => {
  it('removes the proposal block but leaves other code fences alone', () => {
    const reply = `Sure.\n${block([good()])}\n\`\`\`js\nconsole.log(1);\n\`\`\``;
    const stripped = stripTaskBlock(reply);
    expect(stripped).not.toMatch(/verifyCommand/);
    expect(stripped).toMatch(/console\.log\(1\)/);
  });

  it('removes a fence the model never closed', () => {
    const reply = 'Here you go:\n```json\n' + JSON.stringify({ tasks: [good()] });
    const stripped = stripTaskBlock(reply);
    expect(stripped).toBe('Here you go:');
    // And the pair still agree about what counted as a proposal.
    expect(extractTaskProposals(reply).tasks).toHaveLength(1);
  });

  it('removes a bare object with no fence at all', () => {
    const reply = `Sure.\n${JSON.stringify({ tasks: [good()] })}`;
    expect(stripTaskBlock(reply)).toBe('Sure.');
  });

  it('removes the whole payload when a prompt contains fenced code', () => {
    // The regex versions of this either swallowed a following code block (greedy) or stopped
    // inside the first nested fence (lazy). Neither survives what the model actually writes.
    const withFence = good({ prompt: 'It contains:\n```\nfoo\n```\nMake it say bar.' });
    const reply = 'Here:\n```json\n' + JSON.stringify({ tasks: [withFence] }) + '\n```\nGood luck.';
    // A blank line is left where the block stood, which is an ordinary paragraph break. Collapsing
    // it would mean rewriting the model's prose formatting to tidy up after ourselves.
    const stripped = stripTaskBlock(reply);
    expect(stripped).toBe('Here:\n\nGood luck.');
    expect(stripped).not.toMatch(/verifyCommand/);
  });

  it('leaves an unrelated code fence alone even beside a proposal', () => {
    const reply = `${block([good()])}\n\`\`\`js\nconst o = { a: 1 };\n\`\`\``;
    const stripped = stripTaskBlock(reply);
    expect(stripped).toMatch(/const o = \{ a: 1 \}/);
    expect(stripped).not.toMatch(/verifyCommand/);
  });

  it('leaves a reply with no proposal untouched', () => {
    expect(stripTaskBlock('What kind of tasks did you have in mind?'))
      .toBe('What kind of tasks did you have in mind?');
  });
});

describe('the task conversation', () => {
  const current = good({ seed: [{ path: 'a.txt', content: 'x' }] });

  it('carries the task as it stands, so the model revises something concrete', () => {
    // Restating it each turn invites the model to invent from the last thing it said rather than
    // from what is actually stored.
    const prompt = buildTaskChatPrompt(current as any);
    expect(prompt).toMatch(/THE TASK AS IT STANDS/);
    expect(prompt).toMatch(/verifyCommand: cd \/work && node test\.js/);
    expect(prompt).toMatch(/"path":"a\.txt"/);
  });

  it('explains the rule that a referenced file must be seeded', () => {
    expect(buildTaskChatPrompt(current as any)).toMatch(/the agent never sees it/);
  });

  it('reads back only the fields the model actually changed', () => {
    // A merge that filled in omitted fields with defaults would quietly undo edits the
    // conversation never mentioned.
    const revision = extractTaskRevision(
      'Good catch — the file needs to exist first.\n```json\n'
      + JSON.stringify({ task: { seed: [{ path: 'data.txt', content: 'hello' }] } })
      + '\n```',
    );
    expect(revision).toEqual({ seed: [{ path: 'data.txt', content: 'hello' }] });
  });

  it('returns nothing when the reply is only conversation', () => {
    expect(extractTaskRevision('What should the file contain?')).toBeNull();
  });

  it('ignores a block with no usable field', () => {
    expect(extractTaskRevision('```json\n{"task":{"nonsense":1}}\n```')).toBeNull();
  });

  it('reads a revision the model never closed the fence on', () => {
    // Measured against the live deployment: it opens ```json and stops.
    const revision = extractTaskRevision('Here:\n```json\n' + JSON.stringify({ task: { prompt: 'reworded' } }));
    expect(revision).toEqual({ prompt: 'reworded' });
  });
});
