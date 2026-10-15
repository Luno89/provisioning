import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import {
  capabilitiesOf,
  scopedPath,
  type DirEntry,
  type EnvironmentDriver,
  type EnvironmentHandle,
  type EnvironmentScope,
  type EnvironmentSpec,
  type ExecRequest,
  type ExecResult,
  type ExecStopped,
} from '@koala/engine-core';

export interface LocalFsDriverOptions {
  rootDir: string;
  deviceId: string;
  scope?: EnvironmentScope | undefined;
  languages?: string[] | undefined;
  shell?: string | undefined;
}

export const STOP_GRACE_MS = 5_000;

export function createLocalFsDriver(options: LocalFsDriverOptions): EnvironmentDriver {
  const spec: EnvironmentSpec = {
    kind: 'machine',
    lifecycle: 'persistent',
    ...(options.languages ? { languages: [...options.languages] } : {}),
    egress: true,
  };

  const handle: EnvironmentHandle = {
    id: `machine:${options.deviceId}`,
    spec,
    capabilities: capabilitiesOf(spec),
    ...(options.scope ? { scope: options.scope } : {}),
    approval: 'none',
  };

  const absolute = (requested: string): string =>
    path.resolve(options.rootDir, scopedPath(options.scope, requested));

  const workingDir = (requested?: string): string =>
    (requested ? absolute(requested) : path.resolve(options.rootDir, scopedPath(options.scope, '.')));

  return {
    handle: () => handle,

    async exec(request: ExecRequest): Promise<ExecResult> {
      const cwd = workingDir(request.cwd);
      const timeoutMs = request.timeoutMs;

      return new Promise<ExecResult>((resolve) => {
        const child = spawn(options.shell ?? '/bin/bash', ['-lc', request.command], {
          cwd,
          env: { ...process.env, ...(request.env ?? {}) },
          detached: true,
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        let stopped: ExecStopped | undefined;

        const killGroup = (signal: NodeJS.Signals): void => {
          try {
            if (child.pid) process.kill(-child.pid, signal);
          } catch {
            child.kill(signal);
          }
        };

        const stop = (why: ExecStopped): void => {
          if (stopped || settled) return;
          stopped = why;
          killGroup('SIGTERM');
          setTimeout(() => killGroup('SIGKILL'), STOP_GRACE_MS).unref();
        };

        const timer = timeoutMs === undefined ? undefined : setTimeout(() => stop('timeout'), timeoutMs);
        const onAbort = (): void => stop('cancelled');
        if (request.signal?.aborted) onAbort();
        else request.signal?.addEventListener('abort', onAbort, { once: true });

        const finish = (result: ExecResult): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          request.signal?.removeEventListener('abort', onAbort);
          resolve(stopped ? { ...result, stopped } : result);
        };

        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });

        child.on('error', (err) => finish({ stdout, stderr: `${stderr}\n${err.message}`.trim(), exitCode: 127 }));
        child.on('close', (code) => finish({ stdout, stderr, exitCode: code ?? (stopped ? 124 : 0) }));
      });
    },

    async readFile(requested: string): Promise<string> {
      return fs.readFile(absolute(requested), 'utf8');
    },

    async writeFile(requested: string, content: string): Promise<void> {
      const target = absolute(requested);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
    },

    async listDir(requested: string): Promise<DirEntry[]> {
      const entries = await fs.readdir(absolute(requested), { withFileTypes: true });
      return entries
        .filter((entry) => entry.name !== '.git')
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'dir' as const : 'file' as const }));
    },

    async deleteFile(requested: string): Promise<void> {
      await fs.rm(absolute(requested), { recursive: true, force: true });
    },
  };
}
