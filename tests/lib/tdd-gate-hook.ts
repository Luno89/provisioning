import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { commitVerdict, editVerdict, kindOf, siblingTests, type GateState, type TestRun, type Verdict } from './tdd-gate.js';

export interface HookInput { tool_name: string; tool_input: { file_path?: string; command?: string }; cwd: string }
export interface HookAnswer { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string } }

const VITEST = resolve(import.meta.dirname, '..', '..', 'node_modules', '.bin', 'vitest');
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const COMMIT = /(^|[;&|]\s*|\s)git\s+(-C\s+\S+\s+)?commit(\s|$)/;
const RUNNABLE = /\.(test|integration\.test|real-[a-z-]+\.test)\.(ts|tsx)$/;

function git(dir: string, ...args: string[]): string | undefined {
  const run = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : undefined;
}

const lines = (text: string | undefined) => (text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);

function changedTests(root: string): string[] {
  const status = spawnSync('git', ['-C', root, 'status', '--porcelain=v1', '-uall'], { encoding: 'utf8' });
  return (status.status === 0 ? status.stdout : '').split('\n').filter((line) => line.length > 3)
    .filter((line) => line[0] !== 'D' && line[1] !== 'D')
    .map((line) => line.slice(3).replace(/^.* -> /, ''))
    .filter((path) => RUNNABLE.test(path) && existsSync(join(root, path)));
}

function workspaceOf(path: string): string {
  return /^(apps|packages)\/[^/]+\//.exec(path)?.[0].slice(0, -1) ?? '.';
}

function runTests(root: string, tests: string[]): TestRun {
  const byWorkspace = new Map<string, string[]>();
  for (const test of tests) {
    const workspace = workspaceOf(test);
    byWorkspace.set(workspace, [...(byWorkspace.get(workspace) ?? []), workspace === '.' ? test : test.slice(workspace.length + 1)]);
  }
  let passed = true;
  let output = '';
  for (const [workspace, files] of byWorkspace) {
    const run = spawnSync(VITEST, ['run', ...files], { cwd: join(root, workspace), encoding: 'utf8', env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    output += `${run.stdout ?? ''}${run.stderr ?? ''}`;
    if (run.status !== 0) passed = false;
  }
  return { passed, output };
}

function stateFile(root: string): string | undefined {
  const gitDir = git(root, 'rev-parse', '--absolute-git-dir');
  return gitDir ? join(gitDir, 'koala-tdd.json') : undefined;
}

function readState(file: string | undefined): GateState | undefined {
  if (!file || !existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as GateState;
}

const deny = (why: string): HookAnswer => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Red-green-refactor gate: ${why}` } });

function answerOf(verdict: Verdict, root: string, head: string, file: string | undefined): HookAnswer | undefined {
  if (!verdict.allow) return deny(verdict.why);
  if (verdict.red && file) writeFileSync(file, JSON.stringify({ head, red: { tests: verdict.red.tests, at: new Date().toISOString() } } satisfies GateState));
  void root;
  return undefined;
}

function onEdit(input: HookInput): HookAnswer | undefined {
  const target = input.tool_input.file_path;
  if (!target) return undefined;
  const absolute = isAbsolute(target) ? target : resolve(input.cwd, target);
  const root = git(input.cwd, 'rev-parse', '--show-toplevel');
  if (!root) return undefined;
  const path = relative(root, absolute);
  if (path.startsWith('..') || kindOf(path) !== 'source') return undefined;
  const head = git(root, 'rev-parse', 'HEAD') ?? '';
  const file = stateFile(root);
  const state = readState(file);
  if (state?.head === head && state.red) return undefined;
  const tests = changedTests(root);
  const verdict = editVerdict(state, head, tests, tests.length > 0 ? runTests(root, tests) : undefined);
  return answerOf(verdict, root, head, file);
}

function onCommit(input: HookInput): HookAnswer | undefined {
  const command = input.tool_input.command ?? '';
  if (!COMMIT.test(command)) return undefined;
  const root = git(input.cwd, 'rev-parse', '--show-toplevel');
  if (!root) return undefined;
  const all = /\s(-a|--all|-am|-a\s)/.test(` ${command}`);
  const numstat = [...lines(git(root, 'diff', '--cached', '--numstat')), ...(all ? lines(git(root, 'diff', '--numstat')) : [])];
  const changes = numstat.map((line) => { const [added, , path] = line.split('\t'); return { added: Number(added), path: path ?? '' }; });
  const source = changes.filter((change) => kindOf(change.path) === 'source');
  const head = git(root, 'rev-parse', 'HEAD') ?? '';
  const tests = changedTests(root);
  const siblings = [...new Set(source.flatMap((change) => siblingTests(change.path, (path) => existsSync(join(root, path)))))];
  const removalsOnly = source.length > 0 && source.every((change) => change.added === 0);
  const toRun = tests.length > 0 ? tests : siblings;
  const run = source.length > 0 && !removalsOnly && toRun.length > 0 ? runTests(root, toRun) : undefined;
  const verdict = commitVerdict({ state: readState(stateFile(root)), head, source: source.map((change) => change.path), removalsOnly, changedTests: tests, siblings, run });
  return answerOf(verdict, root, head, undefined);
}

export function hookAnswer(input: HookInput): HookAnswer | undefined {
  if (EDITS.has(input.tool_name)) return onEdit(input);
  if (input.tool_name === 'Bash') return onCommit(input);
  return undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const input = JSON.parse(readFileSync(0, 'utf8')) as HookInput;
  const answer = hookAnswer(input);
  if (answer) process.stdout.write(JSON.stringify(answer));
}
