import { describe, it, expect } from 'vitest';
import { detectThoughtLoop, similarity, normalise, REPEATS_BEFORE_STOP, type Turn } from './thought-loop.js';

/**
 * Reading the thought stream to tell circling from working.
 *
 * ── THE EXPENSIVE MISTAKE IS THE FALSE POSITIVE ──
 * Killing a run that was iterating legitimately costs real work, and "run the tests, read the
 * failure, edit the file, run the tests" is repetitive BY NATURE — it is what good work looks like.
 * So most of what follows is negative cases: things that repeat and must not be stopped.
 *
 * The positive cases are drawn from failures actually observed here: a leaf that spent forty turns
 * on `ls`, `cat`, `git log`, and one that rewrote the same file over and over.
 */

const turn = (thought: string, action = ''): Turn => ({ thought, action });

describe('telling one thought from another', () => {
  it('ignores numbers and hashes, which change without anything happening', () => {
    /**
     * The way a loop hides. A timestamp, a line number or a commit sha differing between two
     * otherwise identical turns is not progress, and treating it as novelty makes every repeat
     * look new.
     */
    expect(normalise('retrying at 10:04:12, sha a1b2c3d4e5')).toBe('retrying at sha');
    expect(similarity('attempt 1 failed on line 42', 'attempt 7 failed on line 918')).toBe(1);
  });

  it('treats a reordering as a different thought', () => {
    // Trigrams, not a bag of words: the same vocabulary in a different order is a different idea.
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
    // Too little evidence to call anything. Firing early is how a detector becomes a nuisance.
    expect(detectThoughtLoop([turn('a'), turn('b')]).looping).toBe(false);
  });

  it('leaves honest iteration alone', () => {
    /**
     * The case that matters most. Structurally repetitive — test, read, fix, test — but something
     * different happens each time, and that difference is what separates work from circling.
     */
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
    // `npm test` five times is normal. What it is thinking about each result is not the same.
    const turns = [
      turn('Check the baseline', 'npm test'),
      turn('Now the parser is patched, see if that failure cleared', 'npm test'),
      turn('That fixed two but broke the date test, checking', 'npm test'),
      turn('Dates are ISO now, final confirmation of the whole suite', 'npm test'),
    ];
    expect(detectThoughtLoop(turns).looping).toBe(false);
  });

  it('does not treat silence as self-similar', () => {
    // A model that said nothing is a different problem, and empty turns would otherwise match each
    // other perfectly and fire every time.
    const turns = Array.from({ length: 6 }, () => turn('', ''));
    expect(detectThoughtLoop(turns).looping).toBe(false);
  });
});

describe('what must be stopped', () => {
  it('catches the same thought reworded', () => {
    /**
     * The observed failure: a leaf spent its whole budget hunting for a test runner, saying the
     * same thing each time with the words shuffled.
     */
    const turns = [
      turn('I should look for the test runner configuration first', 'ls -la'),
      turn('I should look for the test runner configuration first', 'ls -la'),
      turn('I should look for the test runner config first', 'ls -la'),
      turn('I should look for the test runner configuration first', 'ls -la'),
    ];
    const v = detectThoughtLoop(turns);
    expect(v.looping).toBe(true);
    expect(v.occurrences).toBeGreaterThanOrEqual(REPEATS_BEFORE_STOP);
    // The diagnosis quotes what repeated, so a person can check the verdict rather than trust it.
    expect(v.reason).toContain('test runner');
  });

  it('catches an A-B-A-B cycle, where no two ADJACENT turns match', () => {
    /**
     * The shape a naive "same as last turn" check misses entirely, and the common one: the agent
     * alternates between two states forever.
     */
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
    /**
     * Why this exists at all: thrash.ts cannot see this one. Every turn writes a file, so no
     * production counter fires, and the run is still getting nowhere.
     */
    const turns = Array.from({ length: 5 }, () =>
      turn('Rewrite the server to fix the port binding', 'write_file src/server.js'));
    expect(detectThoughtLoop(turns).looping).toBe(true);
  });

  it('needs several repeats, not two', () => {
    // Doing the same thing twice is a retry. Doing it four times is a loop.
    const twice = [turn('same thing here now', 'x'), turn('same thing here now', 'x'), turn('a different idea entirely', 'y'), turn('another new direction', 'z')];
    expect(detectThoughtLoop(twice).looping).toBe(false);
  });
});
