import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { workspaceRunning, type KubeRunner, type KubeStreamer } from './kube.js';
import { POD, workspaceName } from './workspace.js';

export type MergeOutcome = 'merged' | 'conflict' | 'nothing' | 'failed';

export interface DocumentRepos {
  push(request: { ownerId: string; repo: string; describe: string; bundle: string }): Promise<{ owner: string; repo: string; commit: string }>;
  pull(request: { ownerId: string; repo: string; bundle: string }): Promise<boolean>;
  merge(request: { ownerId: string; repo: string; head: string; base: string; title: string; body: string }): Promise<MergeOutcome>;
  pushBranch?(request: { ownerId: string; repo: string; describe: string; bundle: string; branch: string }): Promise<string>;
  pullBranch?(request: { ownerId: string; repo: string; branch: string; bundle: string }): Promise<boolean>;
  deleteBranch?(request: { ownerId: string; repo: string; branch: string }): Promise<void>;
}

export interface FolderBranch {
  ownerId: string;
  workspaceRunId: string;
  repo: string;
  folder: string;
  branch: string;
}

export type BroughtBack =
  | { brought: true; commit: string; set?: string | undefined; merged?: true | undefined }
  | { brought: false; why: string; conflicts?: string[] | undefined };

export interface SaveDocuments {
  ownerId: string;
  workspaceRunId: string;
  path: string;
  repo: string;
  describe: string;
  commitAs?: string | undefined;
}

export type SavedDocuments =
  | { saved: true; owner: string; repo: string; commit: string }
  | { saved: false; why: string; empty?: true; failed?: true };

export interface RestoreDocuments {
  ownerId: string;
  workspaceRunId: string;
  path: string;
  repo: string;
}

export type RestoredDocuments = { restored: true } | { restored: false; why: string };

export type BroughtDocuments = { brought: string[] } | { brought: false; why: string };

export interface WorkspaceDocuments {
  save(request: SaveDocuments): Promise<SavedDocuments>;
  restore(request: RestoreDocuments): Promise<RestoredDocuments>;
  bring(request: RestoreDocuments & { from: string }): Promise<BroughtDocuments>;
  catchUp(request: RestoreDocuments & { branch: string }): Promise<void>;
  sendBranch(request: FolderBranch & { message: string; describe: string }): Promise<{ commit: string }>;
  takeBranch(request: FolderBranch & { message?: string | undefined }): Promise<BroughtBack>;
  keepBranch(request: FolderBranch): Promise<{ kept: true; commit: string } | { kept: false; why: string }>;
  dropBranch(request: Omit<FolderBranch, 'folder' | 'workspaceRunId'>): Promise<void>;
  merge(request: { ownerId: string; repo: string; head: string; base: string; title: string; body: string }): Promise<MergeOutcome>;
}

const NO_DIRECTORY = 3;
const NO_HISTORY = 4;

const trusting = (variable: string): string =>
  `export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="${variable}"`;

export const prepareScript = (commit: boolean): string => [
  `cd "$1" 2>/dev/null || exit ${NO_DIRECTORY}`,
  trusting('$1'),
  'set -e',
  ...(commit
    ? [
        'git rev-parse --git-dir >/dev/null 2>&1 || git init -q -b main',
        'git add -A',
        'git diff --cached --quiet || git -c user.name=koala -c user.email=koala@koala.local commit -q -m "$2"',
      ]
    : []),
  'set +e',
  `git rev-parse --verify -q HEAD >/dev/null || exit ${NO_HISTORY}`,
].join('\n');

export const bundleScript = [trusting('$1'), 'exec git -C "$1" bundle create - --all'].join('\n');

const INCOMING = '/tmp/koala-restore.bundle';
const BROUGHT = 'refs/koala/brought';

export const restoreScript = [
  'set -e',
  'mkdir -p "$1"',
  'cd "$1"',
  trusting('$1'),
  'git init -q -b main',
  `git fetch -q --update-head-ok ${INCOMING} '+refs/*:refs/*'`,
  'git reset -q --hard',

  `rm -f ${INCOMING}`,
].join('\n');

export const bringScript = [
  'set -e',
  'cd "$1"',
  trusting('$1'),
  `git fetch -q ${INCOMING} "+HEAD:${BROUGHT}"`,
  `rm -f ${INCOMING}`,
  `git -c core.quotePath=false ls-tree -r --name-only ${BROUGHT} | while IFS= read -r file; do`,
  `  if [ ! -e "$file" ]; then git checkout -q ${BROUGHT} -- "$file"; printf '%s\\n' "$file"; fi`,
  'done',
  `git update-ref -d ${BROUGHT}`,
].join('\n');

export const catchUpScript = [
  'set -e',
  'cd "$1"',
  trusting('$1'),
  `git fetch -q --update-head-ok ${INCOMING} "+refs/heads/$2:refs/heads/$2"`,
  `rm -f ${INCOMING}`,
  'if [ "$(git symbolic-ref -q --short HEAD)" = "$2" ]; then git reset -q --hard "$2"; fi',
].join('\n');

export const BEHIND = 5;
export const CONFLICTED = 6;
const SAVED_MAIN = 'refs/koala/saved-main';
const SAVED_BRANCH = 'main';

export const sendBranchScript = [
  'set -e',
  'mkdir -p "$1"',
  'cd "$1"',
  trusting('$1'),
  'git rev-parse --git-dir >/dev/null 2>&1 || git init -q -b main',
  'git add -A',
  'if ! git rev-parse -q --verify HEAD >/dev/null; then git -c user.name=koala -c user.email=koala@koala.local commit -q --allow-empty -m "$3"',
  'elif ! git diff --cached --quiet; then git -c user.name=koala -c user.email=koala@koala.local commit -q -m "$3"; fi',
  'git branch -f "$2" HEAD',
  'git rev-parse HEAD >&2',
  'git bundle create - "refs/heads/$2"',
  'git branch -D -q "$2"',
].join('\n');

const MACHINE_REF = 'refs/koala/machine';

export const takeBranchScript = [
  'set -e',
  'cd "$1"',
  trusting('$1'),
  `git fetch -q ${INCOMING} "+refs/heads/$2:${MACHINE_REF}"`,
  `rm -f ${INCOMING}`,
  `if ! git merge -q --ff-only ${MACHINE_REF} 2>/dev/null; then`,
  '  set_aside=""',
  '  if [ -n "$(git status --porcelain)" ]; then',
  '    git -c user.name=koala -c user.email=koala@koala.local stash push -q -u -m "set aside when the machine\'s work came back"',
  '    set_aside=$(git rev-parse -q --verify refs/stash)',
  '  fi',
  `  if git merge -q --ff-only ${MACHINE_REF} 2>/dev/null; then :`,
  `  elif git -c user.name=koala -c user.email=koala@koala.local merge -q --no-edit -m "$3" ${MACHINE_REF} >/dev/null 2>&1; then echo merged >&2`,
  '  else',
  '    files=$(git diff --name-only --diff-filter=U | tr "\\n" " ")',
  '    git merge --abort 2>/dev/null || true',
  '    [ -n "$set_aside" ] && git stash pop -q 2>/dev/null || true',
  `    git update-ref -d ${MACHINE_REF}`,
  '    echo "conflicts: $files" >&2',
  `    exit ${CONFLICTED}`,
  '  fi',
  '  [ -n "$set_aside" ] && echo "$set_aside" >&2',
  'fi',
  `git update-ref -d ${MACHINE_REF}`,
  'git rev-parse HEAD',
].join('\n');

export const keepBranchScript = [
  'set -e',
  'cd "$1"',
  trusting('$1'),
  `git fetch -q ${INCOMING} "+refs/heads/$2:refs/heads/$2"`,
  `rm -f ${INCOMING}`,
  'git rev-parse "refs/heads/$2"',
].join('\n');


export const reconcileScript = [
  'cd "$1"',
  trusting('$1'),
  'set -e',
  `git fetch -q ${INCOMING} "+refs/heads/$2:${SAVED_MAIN}"`,
  `rm -f ${INCOMING}`,
  'set +e',
  `if git merge-base --is-ancestor ${SAVED_MAIN} "$2"; then git update-ref -d ${SAVED_MAIN}; exit 0; fi`,
  `[ "$(git symbolic-ref -q --short HEAD)" = "$2" ] || { git update-ref -d ${SAVED_MAIN}; echo "$2 is not checked out here, so what was saved to it elsewhere cannot be merged in" >&2; exit ${BEHIND}; }`,
  `if ! git -c user.name=koala -c user.email=koala@koala.local merge -q --no-edit -m "Merge what was saved to $2 elsewhere" ${SAVED_MAIN}; then`,
  '  files=$(git diff --name-only --diff-filter=U | tr "\\n" " ")',
  '  git merge --abort',
  `  git update-ref -d ${SAVED_MAIN}`,
  `  echo "$2 was changed elsewhere in a way that conflicts with this workspace: $files" >&2`,
  `  exit ${CONFLICTED}`,
  'fi',
  `git update-ref -d ${SAVED_MAIN}`,
].join('\n');

const REJECTED = /\(fetch first\)|non-fast-forward|\[rejected\]/;

export function createWorkspaceDocuments(options: { kube: KubeRunner; stream: KubeStreamer; repos: DocumentRepos }): WorkspaceDocuments {
  const saving = new Map<string, Promise<unknown>>();
  const oneAtATime = <T>(workspaceRunId: string, work: () => Promise<T>): Promise<T> => {
    const next = (saving.get(workspaceRunId) ?? Promise.resolve()).catch(() => undefined).then(work);
    saving.set(workspaceRunId, next);
    void next.finally(() => { if (saving.get(workspaceRunId) === next) saving.delete(workspaceRunId); }).catch(() => undefined);
    return next;
  };

  return {
    save: (request) => oneAtATime(request.workspaceRunId, async (): Promise<SavedDocuments> => {
      const namespace = workspaceName(request.workspaceRunId);
      if (!(await workspaceRunning(options.kube, namespace, POD))) return { saved: false, why: 'the workspace is not running' };

      const commit = request.commitAs !== undefined;
      const prepared = await options.kube(
        ['exec', POD, '-n', namespace, '--', 'sh', '-c', prepareScript(commit), 'sh', request.path, request.commitAs ?? ''],
      );
      if (prepared.exitCode === NO_DIRECTORY) return { saved: false, empty: true, why: `${request.path} does not exist in the workspace` };
      if (prepared.exitCode === NO_HISTORY) return { saved: false, empty: true, why: `${request.path} has nothing committed` };
      if (prepared.exitCode !== 0) throw new Error(`could not prepare ${request.path} to save: ${(prepared.stderr || prepared.stdout).trim()}`);

      const scratch = await mkdtemp(path.join(os.tmpdir(), 'koala-documents-'));
      try {
        const bundle = path.join(scratch, 'documents.bundle');
        const push = async () => {
          const streamed = await options.stream.toFile(['exec', POD, '-n', namespace, '--', 'sh', '-c', bundleScript, 'sh', request.path], bundle);
          if (streamed.exitCode !== 0) throw new Error(`could not bundle ${request.path}: ${streamed.stderr.trim()}`);
          return options.repos.push({ ownerId: request.ownerId, repo: request.repo, describe: request.describe, bundle });
        };
        const pushed = await push().catch(async (err: Error) => {
          if (!REJECTED.test(err.message)) throw err;
          const saved = path.join(scratch, 'saved.bundle');
          if (!(await options.repos.pull({ ownerId: request.ownerId, repo: request.repo, bundle: saved }))) throw err;
          const sent = await options.stream.fromFile(['exec', '-i', POD, '-n', namespace, '--', 'sh', '-c', `cat > ${INCOMING}`], saved);
          if (sent.exitCode !== 0) throw new Error(`could not send what was saved to ${request.repo} into the workspace: ${sent.stderr.trim()}`);
          const merged = await options.kube(['exec', POD, '-n', namespace, '--', 'sh', '-c', reconcileScript, 'sh', request.path, SAVED_BRANCH]);
          if (merged.exitCode !== 0) throw new Error(`${request.repo} could not be saved: ${(merged.stderr || merged.stdout).trim()}`);
          return push();
        });
        return { saved: true, ...pushed };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }),

    async restore(request) {
      const namespace = workspaceName(request.workspaceRunId);
      const present = await options.kube(['exec', POD, '-n', namespace, '--', 'test', '-e', `${request.path}/.git`]);
      if (present.exitCode === 0) return { restored: false, why: `${request.path} already has its history` };

      const scratch = await mkdtemp(path.join(os.tmpdir(), 'koala-documents-'));
      try {
        const bundle = path.join(scratch, 'documents.bundle');
        if (!(await options.repos.pull({ ownerId: request.ownerId, repo: request.repo, bundle }))) return { restored: false, why: `nothing has been saved to ${request.repo} yet` };
        const sent = await options.stream.fromFile(['exec', '-i', POD, '-n', namespace, '--', 'sh', '-c', `cat > ${INCOMING}`], bundle);
        if (sent.exitCode !== 0) throw new Error(`could not send ${request.repo} into the workspace: ${sent.stderr.trim()}`);
        const unpacked = await options.kube(['exec', POD, '-n', namespace, '--', 'sh', '-c', restoreScript, 'sh', request.path]);
        if (unpacked.exitCode !== 0) throw new Error(`could not restore ${request.repo} into ${request.path}: ${(unpacked.stderr || unpacked.stdout).trim()}`);
        return { restored: true };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },

    merge: (request) => options.repos.merge(request),

    async catchUp(request) {
      const namespace = workspaceName(request.workspaceRunId);
      const scratch = await mkdtemp(path.join(os.tmpdir(), 'koala-documents-'));
      try {
        const bundle = path.join(scratch, 'documents.bundle');
        if (!(await options.repos.pull({ ownerId: request.ownerId, repo: request.repo, bundle }))) throw new Error(`nothing has been saved to ${request.repo}`);
        const sent = await options.stream.fromFile(['exec', '-i', POD, '-n', namespace, '--', 'sh', '-c', `cat > ${INCOMING}`], bundle);
        if (sent.exitCode !== 0) throw new Error(`could not send ${request.repo} into the workspace: ${sent.stderr.trim()}`);
        const fetched = await options.kube(['exec', POD, '-n', namespace, '--', 'sh', '-c', catchUpScript, 'sh', request.path, request.branch]);
        if (fetched.exitCode !== 0) throw new Error(`could not bring ${request.branch} of ${request.repo} into ${request.path}: ${(fetched.stderr || fetched.stdout).trim()}`);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },

    sendBranch: (request) => oneAtATime(request.workspaceRunId, async () => {
      if (!options.repos.pushBranch) throw new Error('this host cannot send a workspace\'s work to a machine');
      const namespace = workspaceName(request.workspaceRunId);
      if (!(await workspaceRunning(options.kube, namespace, POD))) throw new Error('the workspace is not running');
      const scratch = await mkdtemp(path.join(os.tmpdir(), 'koala-machine-'));
      try {
        const bundle = path.join(scratch, 'folder.bundle');
        const streamed = await options.stream.toFile(['exec', POD, '-n', namespace, '--', 'sh', '-c', sendBranchScript, 'sh', request.folder, request.branch, request.message], bundle);
        if (streamed.exitCode !== 0) throw new Error(`could not bundle ${request.folder}: ${streamed.stderr.trim()}`);
        await options.repos.pushBranch({ ownerId: request.ownerId, repo: request.repo, describe: request.describe, bundle, branch: request.branch });
        return { commit: streamed.stderr.trim().split('\n').pop() ?? '' };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }),

    takeBranch: (request) => oneAtATime(request.workspaceRunId, async (): Promise<BroughtBack> => {
      if (!options.repos.pullBranch) throw new Error('this host cannot bring a machine\'s work into a workspace');
      const namespace = workspaceName(request.workspaceRunId);
      if (!(await workspaceRunning(options.kube, namespace, POD))) return { brought: false, why: 'the workspace is not running' };
      const scratch = await mkdtemp(path.join(os.tmpdir(), 'koala-machine-'));
      try {
        const bundle = path.join(scratch, 'branch.bundle');
        if (!(await options.repos.pullBranch({ ownerId: request.ownerId, repo: request.repo, branch: request.branch, bundle }))) {
          return { brought: false, why: `the machine has not sent ${request.branch}` };
        }
        const sent = await options.stream.fromFile(['exec', '-i', POD, '-n', namespace, '--', 'sh', '-c', `cat > ${INCOMING}`], bundle);
        if (sent.exitCode !== 0) throw new Error(`could not send the machine's work into the workspace: ${sent.stderr.trim()}`);
        const taken = await options.kube(['exec', POD, '-n', namespace, '--', 'sh', '-c', takeBranchScript, 'sh', request.folder, request.branch, request.message ?? 'Merge the machine\'s work']);
        const said = taken.stderr.trim().split('\n').map((line) => line.trim()).filter(Boolean);
        const conflicting = said.find((line) => line.startsWith('conflicts:'));
        if (taken.exitCode === CONFLICTED && conflicting) {
          const conflicts = conflicting.slice('conflicts:'.length).trim().split(/\s+/).filter(Boolean);
          return { brought: false, why: `the workspace moved on while the machine worked, and these files conflict: ${conflicts.join(', ')}`, conflicts };
        }
        if (taken.exitCode !== 0) return { brought: false, why: (taken.stderr || taken.stdout).trim() };
        const setAside = said.find((line) => /^[0-9a-f]{40}$/.test(line));
        return { brought: true, commit: taken.stdout.trim(), ...(setAside ? { set: setAside } : {}), ...(said.includes('merged') ? { merged: true as const } : {}) };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }),

    keepBranch: (request) => oneAtATime(request.workspaceRunId, async () => {
      if (!options.repos.pullBranch) throw new Error('this host cannot bring a machine\'s work into a workspace');
      const namespace = workspaceName(request.workspaceRunId);
      if (!(await workspaceRunning(options.kube, namespace, POD))) return { kept: false as const, why: 'the workspace is not running' };
      const scratch = await mkdtemp(path.join(os.tmpdir(), 'koala-machine-'));
      try {
        const bundle = path.join(scratch, 'branch.bundle');
        if (!(await options.repos.pullBranch({ ownerId: request.ownerId, repo: request.repo, branch: request.branch, bundle }))) {
          return { kept: false as const, why: `the machine has not sent ${request.branch}` };
        }
        const sent = await options.stream.fromFile(['exec', '-i', POD, '-n', namespace, '--', 'sh', '-c', `cat > ${INCOMING}`], bundle);
        if (sent.exitCode !== 0) throw new Error(`could not send the machine's work into the workspace: ${sent.stderr.trim()}`);
        const kept = await options.kube(['exec', POD, '-n', namespace, '--', 'sh', '-c', keepBranchScript, 'sh', request.folder, request.branch]);
        if (kept.exitCode !== 0) return { kept: false as const, why: (kept.stderr || kept.stdout).trim() };
        return { kept: true as const, commit: kept.stdout.trim() };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }),

    async dropBranch(request) {
      await options.repos.deleteBranch?.({ ownerId: request.ownerId, repo: request.repo, branch: request.branch });
    },

    async bring(request) {
      const namespace = workspaceName(request.workspaceRunId);
      const scratch = await mkdtemp(path.join(os.tmpdir(), 'koala-documents-'));
      try {
        const bundle = path.join(scratch, 'documents.bundle');
        if (!(await options.repos.pull({ ownerId: request.ownerId, repo: request.from, bundle }))) return { brought: false, why: `nothing has been saved to ${request.from}` };
        const sent = await options.stream.fromFile(['exec', '-i', POD, '-n', namespace, '--', 'sh', '-c', `cat > ${INCOMING}`], bundle);
        if (sent.exitCode !== 0) throw new Error(`could not send ${request.from} into the workspace: ${sent.stderr.trim()}`);
        const copied = await options.kube(['exec', POD, '-n', namespace, '--', 'sh', '-c', bringScript, 'sh', request.path]);
        if (copied.exitCode !== 0) throw new Error(`could not bring ${request.from} into ${request.path}: ${(copied.stderr || copied.stdout).trim()}`);
        return { brought: copied.stdout.split('\n').filter((line) => line.length > 0) };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  };
}
