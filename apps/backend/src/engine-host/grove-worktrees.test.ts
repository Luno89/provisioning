import { describe, it, expect } from 'vitest';
import { prepareJudgeCheckout, prepareLeafWorktree, pruneLeafWorktrees, WorktreeConflictError } from './grove-worktrees.js';

function shell(script: (command: string) => { stdout?: string; exitCode?: number } | undefined) {
  const commands: string[] = [];
  const driver = {
    exec: async ({ command }: { command: string }) => {
      commands.push(command);
      const answer = script(command) ?? {};
      return { stdout: answer.stdout ?? '', stderr: '', exitCode: answer.exitCode ?? 0 };
    },
  } as never;
  return { driver, commands };
}

describe('preparing a leaf\'s worktree', () => {
  it('cuts a new branch from main and merges the work of the leaves it waits on', async () => {
    const { driver, commands } = shell((command) => {
      if (command.startsWith('test -e')) return { exitCode: 1 };
      if (command.includes("rev-parse --verify -q 'leaf/c'")) return { exitCode: 1 };
      return undefined;
    });

    await prepareLeafWorktree(driver, 'c', [{ leafId: 'a', commit: 'aaa111' }, { leafId: 'b' }]);

    expect(commands).toContain("git -C /work/repo worktree add -q -b 'leaf/c' '/work/trees/c' main");
    expect(commands.filter((command) => command.includes(' merge '))).toEqual([
      "git -C '/work/trees/c' merge -q --no-edit 'aaa111'",
      "git -C '/work/trees/c' merge -q --no-edit 'leaf/b'",
    ]);
  });

  it('keeps an existing worktree, so a retried leaf continues its own work', async () => {
    const { driver, commands } = shell(() => undefined);

    await prepareLeafWorktree(driver, 'c', [{ leafId: 'a' }]);

    expect(commands.some((command) => command.includes('worktree add'))).toBe(false);
  });

  it('fails the leaf on a merge conflict, naming the files, and leaves nothing half-merged behind', async () => {
    const { driver, commands } = shell((command) => {
      if (command.startsWith('test -e')) return { exitCode: 1 };
      if (command.includes(' merge -q ')) return { exitCode: 1, stdout: 'CONFLICT' };
      if (command.includes('--diff-filter=U')) return { stdout: 'site/index.html\nnginx.conf' };
      return undefined;
    });

    await expect(prepareLeafWorktree(driver, 'c', [{ leafId: 'a' }])).rejects.toThrow(WorktreeConflictError);
    await expect(prepareLeafWorktree(driver, 'c', [{ leafId: 'a' }])).rejects.toThrow('conflicts in site/index.html, nginx.conf');
    expect(commands).toContain("git -C '/work/trees/c' merge --abort");
    expect(commands).toContain("git -C /work/repo worktree remove --force '/work/trees/c'");
  });
});

describe('checking out a claim for its judge', () => {
  it('checks out exactly the claimed commit, detached, in the judge\'s own directory', async () => {
    const { driver, commands } = shell((command) => (command.includes("rev-parse --verify -q 'c0ffee^{commit}'") ? { stdout: 'c0ffee1234' } : undefined));

    expect(await prepareJudgeCheckout(driver, 'a', 'c0ffee')).toBe('c0ffee1234');
    expect(commands).toContain("git -C /work/repo worktree add -q --detach '/work/judge/a' 'c0ffee1234'");
  });

  it('has nothing to check out when the claim names no commit that exists', async () => {
    const { driver } = shell((command) => (command.includes('git -C /work/repo rev-parse --verify') ? { exitCode: 1 } : undefined));
    expect(await prepareJudgeCheckout(driver, 'a', undefined)).toBeUndefined();
  });
});

describe('pruning the work of deleted leaves', () => {
  it('removes the worktree, judge checkout, branch and brief of every leaf that no longer exists, and nothing else', async () => {
    const { driver, commands } = shell((command) => {
      if (command.startsWith('ls -1 /work/trees')) return { stdout: 'kept\ngone\n' };
      if (command.includes('for-each-ref')) return { stdout: 'leaf/kept\nleaf/gone\nleaf/orphan\n' };
      if (command.startsWith('ls -1 /work/repo/leaves')) return { stdout: 'kept.md\ngone.md\n' };
      return undefined;
    });

    const pruned = await pruneLeafWorktrees(driver, ['kept']);

    expect(pruned.sort()).toEqual(['gone', 'orphan']);
    expect(commands).toContain("git -C /work/repo worktree remove --force '/work/trees/gone'; rm -rf '/work/trees/gone'");
    expect(commands).toContain("git -C /work/repo worktree remove --force '/work/judge/gone'; rm -rf '/work/judge/gone'");
    expect(commands).toContain("git -C /work/repo branch -D 'leaf/orphan'");
    expect(commands.some((command) => command.includes("git rm -q --ignore-unmatch 'leaves/gone.md'"))).toBe(true);
    expect(commands.some((command) => command.includes("'leaf/kept'") || command.includes("'/work/trees/kept'"))).toBe(false);
  });

  it('does nothing when every leaf in the sandbox still exists', async () => {
    const { driver, commands } = shell((command) => (command.startsWith('ls -1 /work/trees') ? { stdout: 'kept\n' } : undefined));
    expect(await pruneLeafWorktrees(driver, ['kept'])).toEqual([]);
    expect(commands.some((command) => command.includes('branch -D') || command.includes('worktree remove'))).toBe(false);
  });
});
