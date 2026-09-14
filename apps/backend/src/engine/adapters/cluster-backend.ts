import { buildManifests, workspaceName, POD, type RunWorkspace } from '../workspace.js';
import {
  applyWorkspace,
  destroyWorkspace,
  workspaceRunning,
  type KubeRunner,
} from './kube.js';
import type { DirEntry, ExecResult } from '@koala/engine-core';
import type { SandboxBackend } from '../drivers/sandbox.js';

export { WorkspaceUnavailableError } from './kube.js';

export interface ClusterBackendOptions {
  run: KubeRunner;
  workspace: RunWorkspace;
  readyTimeoutMs?: number | undefined;
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export function createClusterBackend(options: ClusterBackendOptions): SandboxBackend {
  const namespace = workspaceName(options.workspace.runId);
  const { run } = options;
  let standing = false;

  const ensure = async (): Promise<void> => {
    if (standing) return;
    if (await workspaceRunning(run, namespace, POD).catch(() => false)) {
      standing = true;
      return;
    }

    await applyWorkspace(run, {
      manifests: buildManifests(options.workspace),
      namespace,
      pod: POD,
      readyTimeoutMs: options.readyTimeoutMs ?? 120_000,
    });

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

  return {
    async exec({ command, cwd, timeoutMs }): Promise<ExecResult> {
      return exec(cwd ? `cd ${shellQuote(cwd)} && ${command}` : command, timeoutMs);
    },

    async readFile({ path }): Promise<string> {
      const result = await exec(`cat ${shellQuote(path)}`);
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `could not read ${path}`);
      return result.stdout;
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
