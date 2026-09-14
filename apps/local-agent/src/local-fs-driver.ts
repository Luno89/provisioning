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
} from '@koala/engine-core';

export interface LocalFsDriverOptions {
  rootDir: string;
  deviceId: string;
  scope?: EnvironmentScope | undefined;
  languages?: string[] | undefined;
  defaultTimeoutMs?: number | undefined;
  shell?: string | undefined;
}

export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

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
      const timeoutMs = request.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

      return new Promise<ExecResult>((resolve) => {
        const child = spawn(options.shell ?? '/bin/bash', ['-lc', request.command], {
          cwd,
          env: { ...process.env, ...(request.env ?? {}) },
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const finish = (result: ExecResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          finish({
            stdout,
            stderr: `${stderr}\n[stopped after ${Math.round(timeoutMs / 1000)}s]`.trim(),
            exitCode: 124,
          });
        }, timeoutMs);

        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });

        child.on('error', (err) => finish({ stdout, stderr: `${stderr}\n${err.message}`.trim(), exitCode: 127 }));
        child.on('close', (code) => finish({ stdout, stderr, exitCode: code ?? 0 }));
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
