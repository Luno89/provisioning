import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const GUARD = resolve(import.meta.dirname, '..', '..', '.claude', 'hooks', 'command-guard.sh');

function asked(tool: string, input: Record<string, string>): { refused: boolean; why: string; code: number | null } {
  const run = spawnSync('bash', [GUARD], { input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: '/home/luno/Code/provisioning' }), encoding: 'utf8' });
  const said = run.stdout.trim();
  const answer = said ? JSON.parse(said) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } : {};
  return { refused: answer.hookSpecificOutput?.permissionDecision === 'deny', why: answer.hookSpecificOutput?.permissionDecisionReason ?? '', code: run.status };
}

const bash = (command: string) => asked('Bash', { command });

describe('the guard every Bash and file tool call passes through, holding the owner\'s rules a tool can check', () => {
  it('refuses a deadline wrapped around a command, since work ends when it finishes, fails or is stopped', () => {
    expect(bash('timeout 600 npm run decisions').refused).toBe(true);
    expect(bash('cd tests && timeout 30s npx vitest run x.test.ts').refused).toBe(true);
    expect(bash('timeout 600 npm run decisions').why).toMatch(/no deadlines/i);
  });

  it('refuses a push, which only the owner makes', () => {
    expect(bash('git push origin main').refused).toBe(true);
    expect(bash('git -C .claude/worktrees/x push').refused).toBe(true);
    expect(bash('git status && git push').refused).toBe(true);
  });

  it('refuses stopping processes by a pattern, which can match the shell running it', () => {
    expect(bash('pkill -f vitest').refused).toBe(true);
    expect(bash('killall node').refused).toBe(true);
  });

  it('refuses reading or touching the backend\'s secrets file and data folder, by command or by file tool', () => {
    expect(bash('cat apps/backend/.env').refused).toBe(true);
    expect(bash('ls /home/luno/Code/provisioning/apps/backend/data/dev').refused).toBe(true);
    expect(asked('Read', { file_path: '/home/luno/Code/provisioning/apps/backend/.env' }).refused).toBe(true);
    expect(asked('Edit', { file_path: '/home/luno/Code/provisioning/apps/backend/data/x.json' }).refused).toBe(true);
    expect(asked('Grep', { path: 'apps/backend/data' }).refused).toBe(true);
  });

  it('refuses a gate piped through tail and then chained with &&, where the pipe hides the gate\'s exit code', () => {
    expect(bash('npm run lint | tail -5 && git commit -m x').refused).toBe(true);
    expect(bash('npm run lint | tail -5 && git commit -m x').why).toMatch(/exit code/);
  });

  it('lets everyday commands and file reads through untouched', () => {
    for (const command of ['npm run lint', 'git status --short', 'kill 1234', 'grep -n timeout tests/plan.md', 'npm run lint > lint.log 2>&1; echo "lint $?"', 'tail -5 log.txt', 'cat apps/backend/package.json', 'git log --oneline -3']) {
      expect(bash(command).refused, command).toBe(false);
    }
    expect(asked('Read', { file_path: '/home/luno/Code/provisioning/apps/backend/src/index.ts' }).refused).toBe(false);
    expect(bash('npm run lint').code).toBe(0);
  });
});
