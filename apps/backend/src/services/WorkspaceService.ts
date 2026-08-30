import { spawn } from 'child_process';
import path from 'path';
import {
  buildWorkspaceManifests,
  workspaceNamespace,
  WORKSPACE_POD,
  WORKSPACE_MOUNT,
  type WorkspaceSpec,
  type WorkspaceBinding,
} from '../lib/workspace-spec.js';
import { readBindingCredentials } from '../lib/binding-project.js';
import { bindingFiles } from '../lib/binding-resolve.js';
import type { ResolvedBinding } from '../lib/binding-resolve.js';
import type { WorkspaceImageSpec } from '../lib/workspace-image-seeds.js';

const BIN_DIR = path.join(process.cwd(), '..', '..', 'bin');

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
  constructor(private kubeconfigPath?: string) {}

  private run(
    args: string[],
    opts: { stdin?: string | Buffer; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const child = spawn(path.join(BIN_DIR, 'kubectl'), args, {
        env: {
          ...process.env,
          ...(this.kubeconfigPath ? { KUBECONFIG: this.kubeconfigPath } : {}),
        },
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const truncated = stdout.length > MAX_OUTPUT_CHARS || stderr.length > MAX_OUTPUT_CHARS;
        resolve({
          stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
          stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
          exitCode: code ?? -1,
          timedOut,
          truncated,
        });
      });

      if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
      else child.stdin.end();
    });
  }

  async materializeBindings(bindings: readonly ResolvedBinding[]): Promise<WorkspaceBinding[]> {
    const out: WorkspaceBinding[] = [];
    for (const binding of bindings) {
      const credentials = await readBindingCredentials(
        async (args) => (await this.run(args)).stdout,
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
      await this.destroy(spec.leafId).catch(() => undefined);
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
      await this.destroy(leafId).catch(() => undefined);
      reaped.push(leafId);
    }
    return reaped;
  }
}
