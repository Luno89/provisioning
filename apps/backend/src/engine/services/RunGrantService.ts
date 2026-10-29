import { randomUUID } from 'node:crypto';
import type { EngineStore, RunEnding } from '../store.js';
import {
  ended, endedOf, newRunGrant, outsideScopeProblem, revoked, revokes, runGrantProblem,
  type GrantRequest, type Handover, type Revocation, type RevokedBecause, type RunGrant,
} from '../lib/run-grants.js';

export type RunGrantStore = Pick<EngineStore, 'saveRunGrant' | 'getRunGrant' | 'getRunGrantOfRun' | 'getLiveRunGrants' | 'saveRunEnded' | 'saveRunHandover' | 'getRunEndings'>;

export interface RunGrantDeps {
  store: RunGrantStore;
  signalRevoked?: ((runId: string, revocation: { because: RevokedBecause; at: string }) => Promise<void>) | undefined;
  now?: (() => Date) | undefined;
  newId?: (() => string) | undefined;
}

export interface RunEndedEvent {
  ownerId: string;
  runId: string;
  agentSlug: string;
  depth: number;
  outcome: string;
  reason?: string | undefined;
  stoppedBy?: string | undefined;
  revokedBecause?: RevokedBecause | undefined;
  handover?: Handover | undefined;
}

export class RunGrantService {
  private readonly settled = new Map<string, RunGrant>();

  constructor(private readonly deps: RunGrantDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async issue(request: GrantRequest): Promise<RunGrant> {
    const grant = newRunGrant({ id: this.deps.newId?.() ?? `grant-${randomUUID()}`, ...request, now: this.now() });
    await this.deps.store.saveRunGrant(grant);
    return grant;
  }

  async grant(id: string): Promise<RunGrant | undefined> {
    const known = this.settled.get(id);
    if (known) return known;
    const grant = await this.deps.store.getRunGrant(id);
    if (grant && grant.state !== 'live') this.settled.set(id, grant);
    return grant;
  }

  async callProblem(id: string | undefined, tool: string, projectId: string | undefined): Promise<string | undefined> {
    const grant = id ? await this.grant(id) : undefined;
    if (id && !grant) return `This run's grant ${id} is not known here, so it may not use ${tool}.`;
    return runGrantProblem(grant, tool) ?? outsideScopeProblem(grant, projectId, tool);
  }

  async revokeGrantsOf(revocation: Revocation): Promise<RunGrant[]> {
    const now = this.now();
    const ending = (await this.deps.store.getLiveRunGrants(revocation.personId)).filter((grant) => revokes(grant, revocation));
    const done: RunGrant[] = [];
    for (const grant of ending) {
      const gone = revoked(grant, revocation.because, now);
      await this.deps.store.saveRunGrant(gone);
      this.settled.set(gone.id, gone);
      done.push(gone);
      await this.deps.signalRevoked?.(grant.runId, { because: revocation.because, at: now.toISOString() })
        .catch((err: Error) => console.warn(`[run-grants] ${grant.runId} was revoked but not told: ${err.message}`));
    }
    return done;
  }

  async runEnded(event: RunEndedEvent): Promise<{ grant?: RunGrant | undefined; ending: RunEnding }> {
    const now = this.now();
    const grant = event.depth === 0 ? await this.deps.store.getRunGrantOfRun(event.runId) : undefined;
    const closed = grant && grant.state === 'live' ? ended(grant, now) : grant;
    if (closed && closed !== grant) {
      await this.deps.store.saveRunGrant(closed);
      this.settled.set(closed.id, closed);
    }
    const revokedBecause = event.revokedBecause ?? (closed?.state === 'revoked' ? closed.revokedBecause : undefined);
    const ending: RunEnding = {
      runId: event.runId,
      ownerId: event.ownerId,
      agentSlug: event.agentSlug,
      depth: event.depth,
      ended: endedOf(event.outcome, event.reason, { stoppedBy: event.stoppedBy, revokedBecause }, now.toISOString()),
      ...(event.handover ? { handover: event.handover } : {}),
    };
    await this.deps.store.saveRunEnded(ending);
    return { ...(closed ? { grant: closed } : {}), ending };
  }

  async keepHandover(ownerId: string, runId: string, handover: Handover): Promise<void> {
    await this.deps.store.saveRunHandover(ownerId, runId, handover);
  }

  endings(ownerId: string, runIds: readonly string[]): Promise<RunEnding[]> {
    return this.deps.store.getRunEndings(ownerId, runIds);
  }
}
