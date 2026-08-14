import { describe, it, expect } from 'vitest';
import { isProductive, thrashAction, nudgeMessage, thrashSummary, NUDGE_AFTER, STOP_AFTER } from './thrash.js';

const cmd = (command: string) => [{ name: 'run_command', arguments: JSON.stringify({ command }) }];

describe('whether a turn produced anything', () => {
  it('counts writing a file', () => {
    expect(isProductive([{ name: 'write_file', arguments: '{"path":"src/a.js","content":"x"}' }])).toBe(true);
  });

  it('does not count looking around', () => {
    /**
     * The exact commands the failed leaf ran for forty turns, three times over. None of them
     * changes anything, and no number of them was ever going to produce the file it was asked for.
     */
    for (const c of [
      'ls -la /work', 'cat /work/repo/package.json', 'cd /work/repo && git log --oneline -5',
      'cd /work/repo && git status', 'node --version && npm --version', 'npm ls 2>/dev/null',
      'find . -type f', 'which npx',
    ]) {
      expect(isProductive(cmd(c)), c).toBe(false);
    }
  });

  it('does not count running the tests', () => {
    // Valuable, and not production. A loop of `node --test` against a file that does not exist is
    // precisely the failure this detects.
    expect(isProductive(cmd('cd /work/repo && node --test test/a.test.js'))).toBe(false);
  });

  it('counts the commands that change something', () => {
    for (const c of [
      'echo hi > /work/repo/a.txt', 'cat <<EOF | tee /work/a.js', 'mkdir -p /work/repo/test',
      'cd /work/repo && git commit -m "x"', 'cd /work/repo && git push -u origin HEAD',
      'sed -i s/a/b/ file.js', 'npm init -y',
    ]) {
      expect(isProductive(cmd(c)), c).toBe(true);
    }
  });

  it('does not count an install, which cannot do anything here', () => {
    /**
     * Measured: the agent ran `npm init -y` then `npm install --save-dev jest`, and counting the
     * install as production reset the counter twice while nothing was produced. The sandbox has no
     * route to a registry — registry.npmjs.org answers "connection refused".
     */
    expect(isProductive(cmd('cd /work/repo && npm install --save-dev jest'))).toBe(false);
    expect(isProductive(cmd('pip install requests'))).toBe(false);
  });

  it('does not count a redirect into /dev/null', () => {
    // `2>/dev/null` appears on half the inspection commands measured; treating it as production
    // would silence the detector on exactly the runs it is for.
    expect(isProductive(cmd('npm ls 2>/dev/null'))).toBe(false);
  });

  it('treats an unrecognised command as unproductive', () => {
    /**
     * Deliberate asymmetry. A false "productive" silences the detector; a false "unproductive"
     * costs one nudge. The failure being caught is an agent inventing new ways to look around.
     */
    expect(isProductive(cmd('some-unknown-tool --inspect'))).toBe(false);
  });

  it('survives a truncated argument', () => {
    // Long write_file arguments are clipped, so the JSON does not parse.
    expect(isProductive([{ name: 'run_command', arguments: '{"command":"mkdir -p /work/x' }])).toBe(true);
  });
});

describe('when to intervene', () => {
  it('leaves a thorough start alone', () => {
    // The slowest successful run measured began producing at turn 9.
    for (let i = 0; i < NUDGE_AFTER; i++) expect(thrashAction(i)).toBe('continue');
  });

  it('nudges once, not every turn after', () => {
    expect(thrashAction(NUDGE_AFTER)).toBe('nudge');
    expect(thrashAction(NUDGE_AFTER + 1)).toBe('continue');
  });

  it('stops well before the step cap', () => {
    // The point: fire at twenty rather than forty, and leave the rest of the budget unspent.
    expect(thrashAction(STOP_AFTER)).toBe('stop');
    expect(STOP_AFTER).toBeLessThan(40);
  });
});

describe('what it says', () => {
  it('tells the agent the count and what it actually ran', () => {
    // "Get on with it" is what the pacing notes already said, and it did not work. A number it can
    // check against its own transcript is different.
    const msg = nudgeMessage(12, ['git status', 'node --version', 'npm ls']);
    expect(msg).toContain('12 turns');
    expect(msg).toContain('npm ls');
    expect(msg).toMatch(/write_file/);
  });

  it('reports the stop as a different failure from running out of steps', () => {
    /**
     * They need opposite responses — one wants a bigger budget or a smaller task, the other wants
     * the agent to stop inspecting — and reporting both as "ran out of steps" sent a real
     * diagnosis down the wrong path once already.
     */
    const summary = thrashSummary(20, ['git log', 'git status']);
    expect(summary).toMatch(/produced nothing/i);
    expect(summary).toMatch(/not a budget problem/i);
    expect(summary).not.toMatch(/ran out of steps/i);
  });
});
