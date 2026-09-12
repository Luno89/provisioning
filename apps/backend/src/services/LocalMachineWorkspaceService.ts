import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { WorkspaceSpec } from '../lib/workspace-spec.js';
import type { Database } from '../lib/db-interface.js';
import type { LocalEgressRule } from '../lib/types.js';
import { requestApproval, waitForApprovalDecision } from '../lib/leaf-approval.js';
import {
  execOnDevice, readFileOnDevice, writeFileOnDevice, createContainerOnDevice, destroyContainerOnDevice,
  type LocalExecResult,
} from '../lib/local-agent-registry.js';

export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

const DENIED_RESULT = (reason: string): LocalExecResult => ({
  stdout: '', stderr: reason, exitCode: -1, timedOut: false,
});

export interface LocalMachineWorkspaceOptions {
  db: Database;
  approvalMode: 'plan' | 'auto';
  projectId?: string;
  path?: string;
  onHeartbeat?: (note: Record<string, unknown>) => void;
  approvalPollIntervalMs?: number;
  approvalMaxWaitMs?: number;
  egress?: LocalEgressRule[];
  cpu?: string;
  memory?: string;
}

export class LocalMachineWorkspaceService {
  private containerMode = false;

  constructor(
    private deviceId: string,
    private ownerId: string,
    private opts: LocalMachineWorkspaceOptions,
  ) {}

  async materializeBindings(_bindings?: unknown): Promise<never[]> {
    console.warn('[LocalMachineWorkspaceService] service bindings are not yet supported on a local execution target');
    return [];
  }

  /** Set by `create()` from what the agent actually reported — read this only after calling it. */
  executionKind(): 'local-container' | 'local-device' {
    return this.containerMode ? 'local-container' : 'local-device';
  }

  async create(spec: WorkspaceSpec, _readyTimeoutMs?: number, _images?: unknown): Promise<string> {
    const result = await createContainerOnDevice(this.deviceId, this.ownerId, {
      leafId: spec.leafId,
      image: spec.image ?? 'registry.access.redhat.com/ubi9/ubi-minimal',
      ...(this.opts.cpu ? { cpu: this.opts.cpu } : {}),
      ...(this.opts.memory ? { memory: this.opts.memory } : {}),
      ...(this.opts.egress ? { egress: this.opts.egress } : {}),
    });
    this.containerMode = result.containerMode;
    if (result.error) {
      console.warn(`[LocalMachineWorkspaceService] ${spec.leafId}: container create reported "${result.error}" — continuing on raw host exec`);
    }
    return this.deviceId;
  }

  private async approve(leafId: string, description: string): Promise<'approved' | 'denied' | 'timed-out'> {
    if (this.opts.approvalMode !== 'plan') return 'approved';
    const approvalId = uuidv4();
    await requestApproval(this.opts.db, {
      id: approvalId,
      ownerId: this.ownerId,
      leafId,
      command: description,
      ...(this.opts.projectId ? { projectId: this.opts.projectId } : {}),
    });
    return waitForApprovalDecision(this.opts.db, approvalId, {
      onHeartbeat: this.opts.onHeartbeat,
      ...(this.opts.approvalPollIntervalMs ? { pollIntervalMs: this.opts.approvalPollIntervalMs } : {}),
      ...(this.opts.approvalMaxWaitMs ? { maxWaitMs: this.opts.approvalMaxWaitMs } : {}),
    });
  }

  async exec(
    leafId: string,
    command: string,
    timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
    _positional?: string[],
  ): Promise<LocalExecResult> {
    const outcome = await this.approve(leafId, command);
    if (outcome === 'denied') return DENIED_RESULT('This command was denied by a human reviewer.');
    if (outcome === 'timed-out') {
      return DENIED_RESULT('No one approved this command in time — treated as denied. Ask again, or check whether someone is watching this project.');
    }
    return execOnDevice(this.deviceId, this.ownerId, leafId, command, timeoutMs, this.opts.path);
  }

  async writeFile(leafId: string, relativePath: string, content: string): Promise<void> {
    const target = this.resolveRelative(relativePath);
    const outcome = await this.approve(leafId, `write file: ${target}\n\n${content.slice(0, 2000)}`);
    if (outcome === 'denied') throw new Error('This write was denied by a human reviewer.');
    if (outcome === 'timed-out') {
      throw new Error('No one approved this write in time — treated as denied. Ask again, or check whether someone is watching this project.');
    }
    await writeFileOnDevice(this.deviceId, this.ownerId, leafId, target, content);
  }

  async readFile(leafId: string, relativePath: string): Promise<string> {
    return readFileOnDevice(this.deviceId, this.ownerId, leafId, this.resolveRelative(relativePath));
  }

  private resolveRelative(relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      throw new Error(`Path ${JSON.stringify(relativePath)} must be relative to the device's root directory`);
    }
    return this.opts.path ? path.posix.join(this.opts.path, relativePath) : relativePath;
  }

  async destroy(leafId?: string): Promise<void> {
    if (!leafId) return;
    await destroyContainerOnDevice(this.deviceId, this.ownerId, leafId).catch(() => undefined);
  }

  async isRunning(_leafId?: string): Promise<boolean> {
    return true;
  }
}
