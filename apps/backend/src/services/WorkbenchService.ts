/**
 * A live sandbox you can poke at while writing a verify command.
 *
 * ── WHY INTERACTIVE, NOT JUST THE GATE ──
 * The gate answers one question well: does this command fail on the seed and pass on the solution.
 * It cannot tell you WHY a command failed, and while writing one that is the only question you
 * have. `node read.js` exiting 1 could be a missing file, a syntax error, a wrong path, or a tool
 * the image does not carry — and the difference between those is an `ls` away.
 *
 * So this is the same sandbox the agent gets, with the same seed, that you can run commands in. It
 * is deliberately the real thing rather than a local approximation: a verify command tested
 * anywhere else is tested against an environment the run will not use.
 *
 * ── SESSIONS ARE IN MEMORY, PODS ARE NOT ──
 * That asymmetry is the whole risk here. A restart forgets the session while the pod keeps running,
 * so nothing would ever come back for it. Two things cover that: every session has an idle deadline
 * and is reaped when it passes, and `sweepOrphans` asks the CLUSTER what exists rather than asking
 * memory — which is the only question that survives a restart.
 */
import { WorkspaceService } from './WorkspaceService.js';
import { imageForLanguage } from '../lib/workspace-spec.js';
import type { TaskFile, WorkspaceLanguage } from '@koala/harness-types';

/**
 * How long a session may sit unused.
 *
 * Short enough that a forgotten tab does not hold a pod all afternoon, long enough to think between
 * commands. Every exec pushes it back.
 */
const IDLE_MS = 10 * 60_000;

/** Ceiling on one interactive command. Long enough for a build, short enough to notice a hang. */
const EXEC_TIMEOUT_MS = 60_000;

/**
 * How old a workbench pod may be before the orphan sweep takes it, regardless of sessions.
 *
 * Generously above the idle deadline: this is the backstop for pods whose session was lost, not
 * the normal path, and reaping a pod someone is actively using would be worse than leaving one.
 */
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

  /**
   * Opens a sandbox with the seed applied.
   *
   * One per caller rather than one per task: the seed is re-applied on `reset`, so switching task
   * reuses the pod instead of paying startup again.
   */
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

  /** Runs one command. The command is a positional argument — it is never interpolated. */
  async exec(ownerId: string, sessionId: string, command: string): Promise<ExecResult> {
    const session = this.claim(ownerId, sessionId);
    session.lastUsedAt = Date.now();
    // `sh -c "$0"` with the command as $0, for the same reason the gate does it: this text is
    // user- or model-authored, and splicing it in would make any quote a shell injection.
    return this.workspaces.exec(sessionId, 'sh -c "$0"', EXEC_TIMEOUT_MS, [command]);
  }

  /**
   * Back to the state the agent would start in.
   *
   * The point of the window is iterating, and iterating means undoing — a verify command tested
   * against the debris of the last five attempts is being tested against a state no run will have.
   */
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

  /** Sessions past their idle deadline. Called on every open, so an active user does the cleaning. */
  async reapIdle(now = Date.now()): Promise<string[]> {
    const dead = [...this.sessions.values()].filter((s) => now - s.lastUsedAt > IDLE_MS);
    for (const s of dead) {
      this.sessions.delete(s.id);
      await this.workspaces.destroy(s.id).catch(() => undefined);
    }
    return dead.map((s) => s.id);
  }

  /**
   * Pods whose session this process has no memory of.
   *
   * Asks the cluster rather than the map, because a restart empties the map and leaves the pods —
   * the same "absence from memory is not evidence" mistake that once reaped a live experiment, in
   * the opposite direction.
   */
  async sweepOrphans(): Promise<string[]> {
    return this.workspaces.reapStale(ORPHAN_AGE_MS);
  }

  private claim(ownerId: string, sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    // Conflates "no such session" with "not yours" deliberately: a caller who does not own it has
    // no business learning that it exists.
    if (!session || session.ownerId !== ownerId) throw new Error('No such workbench session');
    return session;
  }

  private async applySeed(session: Session): Promise<void> {
    for (const file of session.seed) {
      await this.workspaces.writeFile(session.id, file.path, file.content);
    }
  }
}
