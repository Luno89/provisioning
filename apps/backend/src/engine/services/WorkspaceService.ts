import path from 'path';
import {
  buildWorkspaceManifests,
  workspaceNamespace,
  WORKSPACE_POD,
  WORKSPACE_MOUNT,
  type WorkspaceSpec,
  type WorkspaceBinding,
} from '../lib/workspace-spec.js';
import { readBindingCredentials } from '../../projects/index.js';
import { bindingFiles, type ResolvedBinding } from '../../infrastructure/index.js';
import type { WorkspaceImageSpec } from '../lib/workspace-image-seeds.js';
import type { KubeRunner } from '../../engine-host/sandboxes/kube.js';

export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

export const MAX_OUTPUT_CHARS = 30_000;

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

export class WorkspaceService {
  constructor(private readonly kube: KubeRunner) {}

  private async run(
    args: string[],
    opts: { stdin?: string; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    const result = await this.kube(args, opts.stdin, opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, { outputChars: Infinity });
    return {
      stdout: result.stdout.slice(0, MAX_OUTPUT_CHARS),
      stderr: result.stderr.slice(0, MAX_OUTPUT_CHARS),
      exitCode: result.exitCode,
      timedOut: result.stopped === 'timeout',
      truncated: result.stdout.length > MAX_OUTPUT_CHARS || result.stderr.length >= MAX_OUTPUT_CHARS,
    };
  }

  async materializeBindings(bindings: readonly ResolvedBinding[]): Promise<WorkspaceBinding[]> {
    const out: WorkspaceBinding[] = [];
    for (const binding of bindings) {
      const credentials = await readBindingCredentials(
        async (args) => {
          const read = await this.run(args);
          if (read.exitCode !== 0) throw new Error(`the credentials of ${binding.name} could not be read from ${binding.source.secretName}: ${read.stderr.trim() || `kubectl exited ${read.exitCode}`}`);
          return read.stdout;
        },
        binding,
      );
      const missing = Object.keys(binding.source.keys).filter((k) => credentials[k] === undefined);
      if (missing.length) {
        console.warn(`[workspace] binding ${binding.name}: no value for ${missing.join(', ')}`
          + ` in ${binding.source.secretName}`);
      }
      out.push({ name: binding.name, files: bindingFiles(binding, credentials) });
    }
    return out;
  }

  async create(
    spec: WorkspaceSpec,
    readyTimeoutMs = 120_000,
    images: readonly WorkspaceImageSpec[] = [],
  ): Promise<string> {
    const namespace = workspaceNamespace(spec.leafId);
    const manifests = buildWorkspaceManifests(images, spec);
    const doc = manifests.map((m) => JSON.stringify(m)).join('\n---\n');

    await this.waitForNamespaceGone(namespace);

    const applied = await this.run(['apply', '-f', '-'], { stdin: doc });
    if (applied.exitCode !== 0) {
      throw new Error(`Could not create workspace ${namespace}: ${applied.stderr || applied.stdout}`);
    }

    const ready = await this.run(
      ['wait', '--for=condition=Ready', `pod/${WORKSPACE_POD}`, '-n', namespace, `--timeout=${Math.floor(readyTimeoutMs / 1000)}s`],
      { timeoutMs: readyTimeoutMs + 10_000 },
    );
    if (ready.exitCode !== 0) {
      await this.destroy(spec.leafId).catch((err: unknown) => {
        console.warn(`[workspace] ${namespace} never became ready and could not be removed, so it is left for the stale sweep: ${(err as Error).message}`);
      });
      throw new Error(`Workspace ${namespace} never became ready: ${ready.stderr || ready.stdout}`);
    }
    return namespace;
  }

  private async waitForNamespaceGone(namespace: string, timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const got = await this.run(['get', 'namespace', namespace, '-o', 'jsonpath={.status.phase}'], { timeoutMs: 15_000 });
      if (got.exitCode !== 0) return;
      if (Date.now() > deadline) {
        throw new Error(`Namespace ${namespace} was still ${got.stdout.trim() || 'present'} after ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async exec(
    leafId: string,
    command: string,
    timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
    positional: string[] = [],
  ): Promise<ExecResult> {
    return this.run(
      [
        'exec', WORKSPACE_POD, '-n', workspaceNamespace(leafId), '-i', '--',
        'sh', '-c', command, ...positional,
      ],
      { timeoutMs },
    );
  }

  async writeFile(leafId: string, relativePath: string, content: string): Promise<void> {
    const target = this.resolveInWorkspace(relativePath);
    const result = await this.run(
      [
        'exec', WORKSPACE_POD, '-n', workspaceNamespace(leafId), '-i', '--',
        'sh', '-c', `mkdir -p "$(dirname "$1")" && base64 -d > "$1"`, 'sh', target,
      ],
      { stdin: Buffer.from(content, 'utf8').toString('base64') },
    );
    if (result.exitCode !== 0) throw new Error(`Could not write ${relativePath}: ${result.stderr}`);
  }

  async readFile(leafId: string, relativePath: string): Promise<string> {
    const target = this.resolveInWorkspace(relativePath);
    const result = await this.run([
      'exec', WORKSPACE_POD, '-n', workspaceNamespace(leafId), '-i', '--',
      'sh', '-c', 'base64 "$1"', 'sh', target,
    ]);
    if (result.exitCode !== 0) throw new Error(`Could not read ${relativePath}: ${result.stderr}`);
    return Buffer.from(result.stdout, 'base64').toString('utf8');
  }

  private resolveInWorkspace(relativePath: string): string {
    const resolved = path.posix.resolve(WORKSPACE_MOUNT, relativePath);
    if (resolved !== WORKSPACE_MOUNT && !resolved.startsWith(`${WORKSPACE_MOUNT}/`)) {
      throw new Error(`Path ${JSON.stringify(relativePath)} escapes the workspace`);
    }
    return resolved;
  }

  async destroy(leafId: string): Promise<void> {
    await this.run(
      ['delete', 'namespace', workspaceNamespace(leafId), '--ignore-not-found', '--wait=false'],
      { timeoutMs: 30_000 },
    );
  }

  async isRunning(leafId: string): Promise<boolean> {
    const result = await this.run([
      'get', 'pod', WORKSPACE_POD, '-n', workspaceNamespace(leafId), '-o', 'jsonpath={.status.phase}',
    ], { timeoutMs: 15_000 });
    return result.exitCode === 0 && result.stdout.trim() === 'Running';
  }

  async reapStale(maxAgeMs: number): Promise<string[]> {
    const listed = await this.run([
      'get', 'namespace', '-l', 'app=koala-workspace',
      '-o', 'jsonpath={range .items[*]}{.metadata.name} {.metadata.creationTimestamp} {.metadata.labels.koala\\.dev/leaf}{"\\n"}{end}',
    ], { timeoutMs: 30_000 });
    if (listed.exitCode !== 0) return [];

    const cutoff = Date.now() - maxAgeMs;
    const reaped: string[] = [];
    for (const line of listed.stdout.trim().split('\n').filter(Boolean)) {
      const [, createdAt, leafId] = line.trim().split(/\s+/);
      if (!createdAt || !leafId) continue;
      if (new Date(createdAt).getTime() > cutoff) continue;
      try {
        await this.destroy(leafId);
        reaped.push(leafId);
      } catch (err) {
        console.warn(`[workspace] could not remove the stale workspace of ${leafId}: ${(err as Error).message}`);
      }
    }
    return reaped;
  }
}
