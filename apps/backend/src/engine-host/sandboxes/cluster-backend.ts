import { randomUUID } from 'crypto';
import { workspaceStamp } from '../../lib/published-workspace.js';
import { buildManifests, workspaceName, POD, type RunWorkspace } from './workspace.js';
import {
  applyWorkspace,
  workspaceStampOf,
  destroyWorkspace,
  retirePod,
  type KubeRunner,
} from './kube.js';
import { READ_WHOLE_FILE, wholeFile, type DirEntry, type ExecResult } from '@koala/engine-core';
import type { SandboxBackend } from '../drivers/sandbox.js';

export { WorkspaceUnavailableError } from './kube.js';
export type ClusterBackend = SandboxBackend;

export interface ClusterBackendOptions {
  run: KubeRunner;
  workspace: RunWorkspace;
  readyTimeoutMs?: number | undefined;
  onStarted?: (() => Promise<void>) | undefined;
}

const starting = new Map<string, Promise<void>>();

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export const EXEC_PIDS = '/tmp/.koala-exec';

export const GROUPED_EXEC = [
  `mkdir -p ${EXEC_PIDS}`,
  'if command -v setsid >/dev/null 2>&1; then setsid sh -c "$2" </dev/null & else sh -c "$2" </dev/null & fi',
  'child=$!',
  `echo "$child" > ${EXEC_PIDS}/"$1"`,
  'wait "$child"',
  'code=$?',
  `rm -f ${EXEC_PIDS}/"$1"`,
  'exit "$code"',
].join('\n');

export const STOP_GROUPED_EXEC = [
  `pid=$(cat ${EXEC_PIDS}/"$1" 2>/dev/null) || exit 0`,
  'kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null',
  'for i in 1 2 3 4 5; do kill -0 -"$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null || break; sleep 1; done',
  'kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null',
  `rm -f ${EXEC_PIDS}/"$1"`,
  'exit 0',
].join('\n');

export function createClusterBackend(options: ClusterBackendOptions): SandboxBackend {
  const namespace = workspaceName(options.workspace.runId);
  const { run } = options;
  let standing = false;

  const persistent = options.workspace.persistent === true;

  const wanted = workspaceStamp(options.workspace);
  const startIfStopped = async (): Promise<void> => {
    const standingNow = await workspaceStampOf(run, namespace, POD).catch(() => ({ running: false, stamp: undefined }));
    if (standingNow.running && (!persistent || standingNow.stamp === undefined || standingNow.stamp === wanted)) return;
    if (persistent) await retirePod(run, namespace, POD);
    await applyWorkspace(run, {
      manifests: buildManifests(options.workspace),
      namespace,
      pod: POD,
      readyTimeoutMs: options.readyTimeoutMs ?? 120_000,
    });
    await options.onStarted?.();
  };

  const ensure = async (): Promise<void> => {
    if (standing && !persistent) return;
    let pending = starting.get(namespace);
    if (!pending) {
      pending = startIfStopped().finally(() => starting.delete(namespace));
      starting.set(namespace, pending);
    }
    await pending;
    standing = true;
  };

  const exec = async (command: string, timeoutMs?: number): Promise<ExecResult> => {
    await ensure();
    const result = await run(
      ['exec', POD, '-n', namespace, '-i', '--', 'sh', '-c', command],
      undefined,
      timeoutMs,
    );
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  };

  const execStoppable = async (command: string, request: { timeoutMs?: number | undefined; untimed?: boolean | undefined; signal?: AbortSignal | undefined }): Promise<ExecResult> => {
    await ensure();
    const id = randomUUID();
    const result = await run(
      ['exec', POD, '-n', namespace, '-i', '--', 'sh', '-c', GROUPED_EXEC, 'sh', id, command],
      undefined,
      request.timeoutMs,
      {
        ...(request.untimed ? { untimed: true } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        onStop: async () => { await run(['exec', POD, '-n', namespace, '--', 'sh', '-c', STOP_GROUPED_EXEC, 'sh', id], undefined, 30_000); },
      },
    );
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, ...(result.stopped ? { stopped: result.stopped } : {}) };
  };

  return {
    async exec({ command, cwd, timeoutMs, untimed, signal }): Promise<ExecResult> {
      const full = cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
      if (untimed || signal) return execStoppable(full, { timeoutMs, untimed, signal });
      return exec(full, timeoutMs);
    },

    async readFile({ path }): Promise<string> {
      await ensure();
      const result = await run(
        ['exec', POD, '-n', namespace, '-i', '--', 'sh', '-c', READ_WHOLE_FILE, 'sh', path],
        undefined,
        undefined,
        { outputChars: Infinity },
      );
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `could not read ${path}`);
      return wholeFile(path, result.stdout);
    },

    async writeFile({ path, content }): Promise<void> {
      await ensure();
      const result = await run(
        ['exec', POD, '-n', namespace, '-i', '--', 'sh', '-c',
          'mkdir -p "$(dirname "$1")" && base64 -d > "$1"', 'sh', path],
        Buffer.from(content, 'utf8').toString('base64'),
      );

      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `could not write ${path}`);
      }
    },

    async listDir({ path }): Promise<DirEntry[]> {
      const target = path || '.';
      const result = await exec(`ls -1Ap ${shellQuote(target)}`);

      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `could not list ${target}`);
      }

      return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line !== '.git/')
        .map((line) => (line.endsWith('/')
          ? { name: line.slice(0, -1), type: 'dir' as const }
          : { name: line, type: 'file' as const }));
    },

    async deleteFile({ path }): Promise<void> {
      const result = await exec(`rm -rf ${shellQuote(path)}`);
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `could not delete ${path}`);
    },

    async destroy(): Promise<void> {
      standing = false;
      await destroyWorkspace(run, namespace).catch(() => undefined);
    },
  };
}
