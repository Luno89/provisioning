import { WorkspaceService } from './WorkspaceService.js';
import { imageForLanguage } from '../lib/workspace-spec.js';
import type { TaskFile, WorkspaceLanguage } from '@koala/harness-types';

const IDLE_MS = 10 * 60_000;

const EXEC_TIMEOUT_MS = 60_000;

const ORPHAN_AGE_MS = 60 * 60_000;

interface Session {
  id: string;
  ownerId: string;
  language: WorkspaceLanguage;
  seed: TaskFile[];
  lastUsedAt: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export class WorkbenchService {
  private sessions = new Map<string, Session>();

  constructor(
    private workspaces = new WorkspaceService(process.env.WORKSPACE_KUBECONFIG),
  ) {}

  async open(
    ownerId: string,
    opts: { language?: WorkspaceLanguage; seed?: TaskFile[] } = {},
  ): Promise<{ sessionId: string }> {
    await this.reapIdle();

    const id = `wb-${ownerId.slice(0, 8)}-${Date.now().toString(36)}`;
    const language = opts.language ?? 'node';
    await this.workspaces.create({ leafId: id, ownerId, image: imageForLanguage(language) });

    const session: Session = { id, ownerId, language, seed: opts.seed ?? [], lastUsedAt: Date.now() };
    this.sessions.set(id, session);
    await this.applySeed(session);
    return { sessionId: id };
  }

  async exec(ownerId: string, sessionId: string, command: string): Promise<ExecResult> {
    const session = this.claim(ownerId, sessionId);
    session.lastUsedAt = Date.now();
    return this.workspaces.exec(sessionId, 'sh -c "$0"', EXEC_TIMEOUT_MS, [command]);
  }

  async reset(
    ownerId: string,
    sessionId: string,
    seed?: TaskFile[],
  ): Promise<void> {
    const session = this.claim(ownerId, sessionId);
    session.lastUsedAt = Date.now();
    if (seed) session.seed = seed;
    await this.workspaces.exec(sessionId, 'rm -rf /work/* /work/.[!.]* 2>/dev/null; true');
    await this.applySeed(session);
  }

  async close(ownerId: string, sessionId: string): Promise<void> {
    this.claim(ownerId, sessionId);
    this.sessions.delete(sessionId);
    await this.workspaces.destroy(sessionId).catch(() => undefined);
  }

  async reapIdle(now = Date.now()): Promise<string[]> {
    const dead = [...this.sessions.values()].filter((s) => now - s.lastUsedAt > IDLE_MS);
    for (const s of dead) {
      this.sessions.delete(s.id);
      await this.workspaces.destroy(s.id).catch(() => undefined);
    }
    return dead.map((s) => s.id);
  }

  async sweepOrphans(): Promise<string[]> {
    return this.workspaces.reapStale(ORPHAN_AGE_MS);
  }

  private claim(ownerId: string, sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session || session.ownerId !== ownerId) throw new Error('No such workbench session');
    return session;
  }

  private async applySeed(session: Session): Promise<void> {
    for (const file of session.seed) {
      await this.workspaces.writeFile(session.id, file.path, file.content);
    }
  }
}
