import type { EnvironmentDriver } from '@koala/engine-core';
import { judgeCheckout, leafBranch, leafBriefPath, leafWorktree, TREE_REPO } from '../lib/plan-documents.js';

export interface LeafDependency {
  leafId: string;
  commit?: string | undefined;
}

export class WorktreeConflictError extends Error {
  constructor(readonly leafId: string, readonly files: string[]) {
    super(`merging the work of ${leafId}'s dependencies conflicts in ${files.join(', ') || 'files git would not name'}`);
    this.name = 'WorktreeConflictError';
  }
}

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const at = (relative: string): string => `/work/${relative}`;

async function run(driver: EnvironmentDriver, command: string): Promise<{ ok: boolean; out: string }> {
  const outcome = await driver.exec({ command, timeoutMs: 120_000 });
  return { ok: outcome.exitCode === 0, out: (outcome.stdout || outcome.stderr).trim() };
}

async function must(driver: EnvironmentDriver, command: string): Promise<string> {
  const outcome = await run(driver, command);
  if (!outcome.ok) throw new Error(`${command.split(' ').slice(0, 3).join(' ')} failed: ${outcome.out}`);
  return outcome.out;
}

export async function ensureTreeRepo(driver: EnvironmentDriver): Promise<void> {
  await must(driver, 'git config --global user.name koala && git config --global user.email koala@grove.local');
  await must(driver, `mkdir -p ${TREE_REPO} && cd ${TREE_REPO} && (git rev-parse --verify -q HEAD >/dev/null || ((git rev-parse --git-dir >/dev/null 2>&1 || git init -q -b main) && git commit -q --allow-empty -m 'tree: start'))`);
}

export async function prepareLeafWorktree(driver: EnvironmentDriver, leafId: string, dependencies: readonly LeafDependency[]): Promise<void> {
  await ensureTreeRepo(driver);
  const path = at(leafWorktree(leafId));
  const branch = leafBranch(leafId);

  if ((await run(driver, `test -e ${quote(path)}/.git`)).ok) return;

  const branchExists = (await run(driver, `git -C ${TREE_REPO} rev-parse --verify -q ${quote(branch)}`)).ok;
  await must(driver, branchExists
    ? `git -C ${TREE_REPO} worktree add -q ${quote(path)} ${quote(branch)}`
    : `git -C ${TREE_REPO} worktree add -q -b ${quote(branch)} ${quote(path)} main`);

  for (const dependency of dependencies) {
    const source = dependency.commit ?? leafBranch(dependency.leafId);
    if (!(await run(driver, `git -C ${TREE_REPO} rev-parse --verify -q ${quote(`${source}^{commit}`)}`)).ok) continue;
    const merged = await run(driver, `git -C ${quote(path)} merge -q --no-edit ${quote(source)}`);
    if (!merged.ok) {
      const conflicted = await run(driver, `git -C ${quote(path)} diff --name-only --diff-filter=U`);
      await run(driver, `git -C ${quote(path)} merge --abort`);
      await run(driver, `git -C ${TREE_REPO} worktree remove --force ${quote(path)}`);
      throw new WorktreeConflictError(leafId, conflicted.out.split('\n').filter(Boolean));
    }
  }
}

const listed = (out: string): string[] => out.split('\n').map((line) => line.trim()).filter(Boolean);

export async function pruneLeafWorktrees(driver: EnvironmentDriver, liveLeafIds: readonly string[]): Promise<string[]> {
  await ensureTreeRepo(driver);
  const live = new Set(liveLeafIds);
  const worktrees = listed((await run(driver, `ls -1 ${at('trees')} ${at('judge')} 2>/dev/null | grep -v ':$' || true`)).out);
  const branches = listed((await run(driver, `git -C ${TREE_REPO} for-each-ref --format='%(refname:short)' refs/heads/leaf/`)).out)
    .map((branch) => branch.replace(/^leaf\//, ''));
  const briefs = listed((await run(driver, `ls -1 ${TREE_REPO}/leaves 2>/dev/null || true`)).out)
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.replace(/\.md$/, ''));
  const stale = [...new Set([...worktrees, ...branches, ...briefs])].filter((leafId) => !live.has(leafId));
  if (stale.length === 0) return [];

  for (const leafId of stale) {
    for (const path of [at(leafWorktree(leafId)), at(judgeCheckout(leafId))]) {
      await run(driver, `git -C ${TREE_REPO} worktree remove --force ${quote(path)}; rm -rf ${quote(path)}`);
    }
  }
  await run(driver, `git -C ${TREE_REPO} worktree prune`);
  for (const leafId of stale) await run(driver, `git -C ${TREE_REPO} branch -D ${quote(leafBranch(leafId))}`);
  const briefPaths = stale.filter((leafId) => briefs.includes(leafId)).map((leafId) => quote(leafBriefPath(leafId)));
  if (briefPaths.length > 0) {
    await must(driver, `cd ${TREE_REPO} && git rm -q --ignore-unmatch ${briefPaths.join(' ')} && (git diff --cached --quiet || git commit -q -m ${quote(`prune: ${stale.length} deleted leaf${stale.length === 1 ? '' : 'ves'}`)})`);
  }
  return stale;
}

export async function prepareJudgeCheckout(driver: EnvironmentDriver, leafId: string, commit: string | undefined): Promise<string | undefined> {
  await ensureTreeRepo(driver);
  const source = commit ?? leafBranch(leafId);
  const resolved = await run(driver, `git -C ${TREE_REPO} rev-parse --verify -q ${quote(`${source}^{commit}`)}`);
  if (!resolved.ok) return undefined;

  const path = at(judgeCheckout(leafId));
  await run(driver, `git -C ${TREE_REPO} worktree remove --force ${quote(path)}`);
  await run(driver, `rm -rf ${quote(path)} && git -C ${TREE_REPO} worktree prune`);
  await must(driver, `git -C ${TREE_REPO} worktree add -q --detach ${quote(path)} ${quote(resolved.out)}`);
  return resolved.out;
}

const lines = (text: string): string[] => text.split('\n').map((line) => line.trim()).filter(Boolean);

export async function worktreeHead(driver: EnvironmentDriver): Promise<{ commit?: string | undefined; dirty: string[]; changed: string[] }> {
  const status = await run(driver, 'git status --porcelain');
  if (!status.ok) return { dirty: [], changed: [] };
  const head = await run(driver, 'git rev-parse HEAD');
  const changed = head.ok ? await run(driver, 'git -c core.quotePath=false diff --name-only --diff-filter=d main...HEAD') : undefined;
  return {
    ...(head.ok ? { commit: head.out } : {}),
    dirty: lines(status.out),
    changed: changed?.ok ? lines(changed.out) : [],
  };
}
