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
}

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
        undefined,
        120_000,
      );
      if (prepared.exitCode === NO_DIRECTORY) return { saved: false, empty: true, why: `${request.path} does not exist in the workspace` };
      if (prepared.exitCode === NO_HISTORY) return { saved: false, empty: true, why: `${request.path} has nothing committed` };
      if (prepared.exitCode !== 0) throw new Error(`could not prepare ${request.path} to save: ${(prepared.stderr || prepared.stdout).trim()}`);

      const scratch = await mkdtemp(path.join(os.tmpdir(), 'koala-documents-'));
      try {
        const bundle = path.join(scratch, 'documents.bundle');
        const streamed = await options.stream.toFile(['exec', POD, '-n', namespace, '--', 'sh', '-c', bundleScript, 'sh', request.path], bundle);
        if (streamed.exitCode !== 0) throw new Error(`could not bundle ${request.path}: ${streamed.stderr.trim()}`);
        const pushed = await options.repos.push({ ownerId: request.ownerId, repo: request.repo, describe: request.describe, bundle });
        return { saved: true, ...pushed };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }),

    async restore(request) {
      const namespace = workspaceName(request.workspaceRunId);
      const present = await options.kube(['exec', POD, '-n', namespace, '--', 'test', '-e', `${request.path}/.git`], undefined, 30_000);
      if (present.exitCode === 0) return { restored: false, why: `${request.path} already has its history` };

      const scratch = await mkdtemp(path.join(os.tmpdir(), 'koala-documents-'));
      try {
        const bundle = path.join(scratch, 'documents.bundle');
        if (!(await options.repos.pull({ ownerId: request.ownerId, repo: request.repo, bundle }))) return { restored: false, why: `nothing has been saved to ${request.repo} yet` };
        const sent = await options.stream.fromFile(['exec', '-i', POD, '-n', namespace, '--', 'sh', '-c', `cat > ${INCOMING}`], bundle);
        if (sent.exitCode !== 0) throw new Error(`could not send ${request.repo} into the workspace: ${sent.stderr.trim()}`);
        const unpacked = await options.kube(['exec', POD, '-n', namespace, '--', 'sh', '-c', restoreScript, 'sh', request.path], undefined, 120_000);
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
        const fetched = await options.kube(['exec', POD, '-n', namespace, '--', 'sh', '-c', catchUpScript, 'sh', request.path, request.branch], undefined, 120_000);
        if (fetched.exitCode !== 0) throw new Error(`could not bring ${request.branch} of ${request.repo} into ${request.path}: ${(fetched.stderr || fetched.stdout).trim()}`);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },

    async bring(request) {
      const namespace = workspaceName(request.workspaceRunId);
      const scratch = await mkdtemp(path.join(os.tmpdir(), 'koala-documents-'));
      try {
        const bundle = path.join(scratch, 'documents.bundle');
        if (!(await options.repos.pull({ ownerId: request.ownerId, repo: request.from, bundle }))) return { brought: false, why: `nothing has been saved to ${request.from}` };
        const sent = await options.stream.fromFile(['exec', '-i', POD, '-n', namespace, '--', 'sh', '-c', `cat > ${INCOMING}`], bundle);
        if (sent.exitCode !== 0) throw new Error(`could not send ${request.from} into the workspace: ${sent.stderr.trim()}`);
        const copied = await options.kube(['exec', POD, '-n', namespace, '--', 'sh', '-c', bringScript, 'sh', request.path], undefined, 120_000);
        if (copied.exitCode !== 0) throw new Error(`could not bring ${request.from} into ${request.path}: ${(copied.stderr || copied.stdout).trim()}`);
        return { brought: copied.stdout.split('\n').filter((line) => line.length > 0) };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  };
}
