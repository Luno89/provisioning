import { describe, it, expect } from 'vitest';
import { runTaskChecks, checksFailed, checkReport, type CheckEnvironment } from './task-checks.js';

interface Reply { stdout?: string; stderr?: string; exitCode?: number }

const environment = (respond: (command: string) => Reply, files: Record<string, string | undefined> = {}) => {
  const ran: string[] = [];
  return {
    ran,
    exec: async (command: string) => {
      ran.push(command);
      const reply = respond(command);
      return { stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', exitCode: reply.exitCode ?? 0 };
    },
    readFile: async (path: string) => files[path],
  };
};

const quiet = () => ({});

describe('a file a task says must exist', () => {
  it('passes when it is there and not empty', async () => {
    const outcomes = await runTaskChecks(environment(() => ({})), { fileExists: 'paper.md' });

    expect(outcomes).toEqual([{ check: 'paper.md exists and is not empty', passed: true, says: 'it is there' }]);
  });

  it('fails when it is missing, and quotes the path it tested', async () => {
    const world = environment((command) => (command.startsWith('test -s') ? { exitCode: 1 } : {}));

    const [outcome] = await runTaskChecks(world, { fileExists: "it's here.md" });

    expect(outcome).toMatchObject({ passed: false, says: 'it is missing or empty' });
    expect(world.ran[0]).toBe(`test -s 'it'\\''s here.md'`);
  });
});

describe('a pattern a file must match', () => {
  const files = { 'notes.md': 'first line\nsecond line\n' };

  it('matches across lines, because a check names a line not a file', async () => {
    const [outcome] = await runTaskChecks(environment(quiet, files), { contentPath: 'notes.md', contentPattern: '^second' });

    expect(outcome).toMatchObject({ passed: true, says: 'the pattern is in it' });
  });

  it('fails when the pattern is not in the file', async () => {
    const [outcome] = await runTaskChecks(environment(quiet, files), { contentPath: 'notes.md', contentPattern: 'third' });

    expect(outcome).toMatchObject({ passed: false, says: 'the pattern is not in it' });
  });

  it('fails saying the file could not be read, rather than passing quietly', async () => {
    const [outcome] = await runTaskChecks(environment(quiet, {}), { contentPath: 'gone.md', contentPattern: 'x' });

    expect(outcome).toMatchObject({ passed: false, says: 'the file could not be read' });
  });

  it('says what is wrong with a pattern that is not a regular expression', async () => {
    const [outcome] = await runTaskChecks(environment(quiet, files), { contentPath: 'notes.md', contentPattern: '[' });

    expect(outcome?.passed).toBe(false);
    expect(outcome?.says).toMatch(/not a regular expression/);
  });
});

describe('a command a task says must hold', () => {
  it('passes when it exits clean and says everything expected', async () => {
    const world = environment(() => ({ stdout: 'hello world\n' }));

    const [outcome] = await runTaskChecks(world, { command: 'sh test.sh', expects: ['hello', 'world'] });

    expect(outcome).toMatchObject({ passed: true, check: 'sh test.sh says "hello", "world"' });
  });

  it('fails on the output it did not contain', async () => {
    const [outcome] = await runTaskChecks(environment(() => ({ stdout: 'hello world\n' })), { command: 'sh test.sh', expects: ['hello', 'goodbye'] });

    expect(outcome).toMatchObject({ passed: false, says: 'its output did not contain "goodbye"' });
  });

  it('fails on a non-zero exit, carrying what the command said', async () => {
    const [outcome] = await runTaskChecks(
      environment(() => ({ exitCode: 2, stderr: 'test.sh: not found' })),
      { command: 'sh test.sh' },
    );

    expect(outcome).toMatchObject({ passed: false, check: 'sh test.sh exits clean' });
    expect(outcome?.says).toContain('it exited 2: test.sh: not found');
  });
});

describe('an endpoint a task says must answer', () => {
  it('probes from inside the workspace and compares the status', async () => {
    const world = environment(() => ({ stdout: '200' }));

    const [outcome] = await runTaskChecks(world, { httpUrl: 'http://localhost:3000/health' });

    expect(outcome).toMatchObject({ passed: true, says: 'it answered 200' });
    expect(world.ran[0]).toContain(`curl -s -o /dev/null -w '%{http_code}'`);
    expect(world.ran[0]).toContain(`'http://localhost:3000/health'`);
  });

  it('fails on the status it answered with', async () => {
    const [outcome] = await runTaskChecks(environment(() => ({ stdout: '404' })), { httpUrl: 'http://x/health', httpStatus: 200 });

    expect(outcome).toMatchObject({ passed: false, says: 'it answered 404' });
  });

  it('says when the workspace has no curl to probe with, instead of failing the work', async () => {
    const [outcome] = await runTaskChecks(environment(() => ({ exitCode: 127 })), { httpUrl: 'http://x/health' });

    expect(outcome?.says).toContain('curl is not installed');
  });
});

describe('the report a claim carries', () => {
  it('has nothing to run for a task with no checks', async () => {
    expect(await runTaskChecks(environment(quiet), undefined)).toEqual([]);
    expect(checksFailed([])).toBe(false);
  });

  it('names each check and what it said, so a replan can see which one failed', async () => {
    const outcomes = await runTaskChecks(
      environment((command) => (command.startsWith('test -s') ? {} : { exitCode: 1, stderr: 'boom' })),
      { fileExists: 'paper.md', command: 'sh test.sh' },
    );

    expect(checksFailed(outcomes)).toBe(true);
    expect(checkReport(outcomes)).toBe(
      'passed — paper.md exists and is not empty: it is there\nFAILED — sh test.sh exits clean: it exited 1: boom',
    );
  });
});
