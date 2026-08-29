import { describe, it, expect } from 'vitest';
import { detectThoughtLoop, similarity, normalise, REPEATS_BEFORE_STOP, type Turn } from './thought-loop.js';

const turn = (thought: string, action = ''): Turn => ({ thought, action });

describe('telling one thought from another', () => {
  it('ignores numbers and hashes, which change without anything happening', () => {
    expect(normalise('retrying at 10:04:12, sha a1b2c3d4e5')).toBe('retrying at sha');
    expect(similarity('attempt 1 failed on line 42', 'attempt 7 failed on line 918')).toBe(1);
  });

  it('treats a reordering as a different thought', () => {
    expect(similarity('read the file then write the test', 'write the test then read the file'))
      .toBeLessThan(0.85);
  });

  it('scores identical text as identical and unrelated text as not', () => {
    expect(similarity('install the dependency and run the suite', 'install the dependency and run the suite')).toBe(1);
    expect(similarity('install the dependency', 'delete the kubernetes namespace')).toBeLessThan(0.2);
  });
});

describe('what must NOT be stopped', () => {
  it('leaves a short run alone', () => {
    expect(detectThoughtLoop([turn('a'), turn('b')]).looping).toBe(false);
  });

  it('leaves honest iteration alone', () => {
    const turns = [
      turn('Run the suite to see where it stands', 'npm test'),
      turn('Two failures in the parser, both about missing null checks', 'cat src/parse.js'),
      turn('Add the null guard to parseHeader', 'write_file src/parse.js'),
      turn('Run the suite again to confirm the parser is fixed', 'npm test'),
      turn('One failure left, in the serialiser this time, about date formats', 'cat src/serialise.js'),
      turn('Fix the date format to ISO', 'write_file src/serialise.js'),
    ];
    expect(detectThoughtLoop(turns).looping).toBe(false);
  });

  it('leaves a run that repeats a COMMAND but reasons differently', () => {
    const turns = [
      turn('Check the baseline', 'npm test'),
      turn('Now the parser is patched, see if that failure cleared', 'npm test'),
      turn('That fixed two but broke the date test, checking', 'npm test'),
      turn('Dates are ISO now, final confirmation of the whole suite', 'npm test'),
    ];
    expect(detectThoughtLoop(turns).looping).toBe(false);
  });

  it('does not treat silence as self-similar', () => {
    const turns = Array.from({ length: 6 }, () => turn('', ''));
    expect(detectThoughtLoop(turns).looping).toBe(false);
  });
});

describe('what must be stopped', () => {
  it('catches the same thought reworded', () => {
    const turns = [
      turn('I should look for the test runner configuration first', 'ls -la'),
      turn('I should look for the test runner configuration first', 'ls -la'),
      turn('I should look for the test runner config first', 'ls -la'),
      turn('I should look for the test runner configuration first', 'ls -la'),
    ];
    const v = detectThoughtLoop(turns);
    expect(v.looping).toBe(true);
    expect(v.occurrences).toBeGreaterThanOrEqual(REPEATS_BEFORE_STOP);
    expect(v.reason).toContain('test runner');
  });

  it('catches an A-B-A-B cycle, where no two ADJACENT turns match', () => {
    const turns = [
      turn('Check whether the module exists', 'cat src/client.js'),
      turn('It is not there, so write it', 'write_file src/client.js'),
      turn('Check whether the module exists', 'cat src/client.js'),
      turn('It is not there, so write it', 'write_file src/client.js'),
      turn('Check whether the module exists', 'cat src/client.js'),
      turn('It is not there, so write it', 'write_file src/client.js'),
    ];
    expect(detectThoughtLoop(turns).looping).toBe(true);
  });

  it('catches a busy loop that mutates every turn', () => {
    const turns = Array.from({ length: 5 }, () =>
      turn('Rewrite the server to fix the port binding', 'write_file src/server.js'));
    expect(detectThoughtLoop(turns).looping).toBe(true);
  });

  it('needs several repeats, not two', () => {
    const twice = [turn('same thing here now', 'x'), turn('same thing here now', 'x'), turn('a different idea entirely', 'y'), turn('another new direction', 'z')];
    expect(detectThoughtLoop(twice).looping).toBe(false);
  });
});
