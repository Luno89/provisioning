import { randomUUID } from 'node:crypto';
import { decryptValue, encryptValue, keepTrying, reopening, tokenAlreadyGone, type DependencyRefusals, type Reopening, type SecretKey } from '../../platform/index.js';
import type { EngineStore } from '../store.js';
import type { HeldRunToken, RunGrant } from '../lib/run-grants.js';

export interface RunToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface RunTokenRoot {
  runToken(runId: string, space?: string): Promise<RunToken>;
  renewRunToken(refreshToken: string): Promise<RunToken>;
  endRunToken(refreshToken: string): Promise<void>;
}

export type RunTokenStore = Pick<EngineStore, 'getRunGrant' | 'getRunGrantOfRun' | 'swapRunGrantToken' | 'getRunGrantTokens' | 'dropRunGrantToken' | 'getRunGrantsHoldingTokens'>;

export interface RunTokensDeps {
  store: RunTokenStore;
  root: RunTokenRoot | { none: string };
  dataKey: SecretKey;
  log: (message: string) => void;
  holder?: string | undefined;
  now?: (() => number) | undefined;
  again?: (() => Reopening) | undefined;
  refusals: DependencyRefusals;
}

const RENEW_WITHIN_MS = 30_000;

function revokedUnlessRefused(err: unknown): void {
  if (!tokenAlreadyGone(err)) throw err;
}

const spaceActedAs = (grant: RunGrant): string | undefined =>
  grant.principal.claims.some((claim) => claim.role === 'space-of') ? grant.principal.id : undefined;

const keyPart = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_');

export class RunTokens {
  private readonly holder: string;
  private readonly asking = new Map<string, Promise<string>>();

  constructor(private readonly deps: RunTokensDeps) {
    this.holder = keyPart(deps.holder ?? randomUUID());
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  bearerFor(grantId: string, space?: string): Promise<string> {
    const asked = JSON.stringify([grantId, space ?? '']);
    const running = this.asking.get(asked);
    if (running) return running;
    const getting = this.current(grantId, space).finally(() => this.asking.delete(asked));
    this.asking.set(asked, getting);
    return getting;
  }

  async bearerForRun(runId: string, space?: string): Promise<string> {
    const grant = await this.deps.store.getRunGrantOfRun(runId);
    if (!grant) throw new Error(`run ${runId} holds no grant here, so it holds no token`);
    return this.bearerFor(grant.id, space);
  }

  private async current(grantId: string, asked: string | undefined): Promise<string> {
    const grant = await this.deps.store.getRunGrant(grantId);
    if (!grant) throw new Error(`the run grant ${grantId} is not known here, so it holds no token`);
    if (grant.state === 'ended') throw new Error(`run ${grant.runId} has ended, so it holds no token`);
    if (grant.state === 'revoked') throw new Error(`run ${grant.runId}'s access was taken away, so it holds no token`);
    const actsAs = spaceActedAs(grant);
    if (actsAs && asked && asked !== actsAs) throw new Error(`run ${grant.runId} acts as space ${actsAs}, not ${asked}`);
    const space = actsAs ?? asked;
    const { root } = this.deps;
    if ('none' in root) throw new Error(root.none);

    const key = space ? `${this.holder}-${keyPart(space)}` : this.holder;
    const held = (await this.deps.store.getRunGrantTokens(grantId)).find((token) => token.key === key);
    if (held && held.expiresAt - this.now() > RENEW_WITHIN_MS) return decryptValue(held.access, this.deps.dataKey);

    const got = held ? await root.renewRunToken(decryptValue(held.refresh, this.deps.dataKey)) : await root.runToken(grant.runId, space);
    const next: HeldRunToken = {
      key,
      turn: (held?.turn ?? 0) + 1,
      access: encryptValue(got.accessToken, this.deps.dataKey),
      refresh: encryptValue(got.refreshToken, this.deps.dataKey),
      expiresAt: got.expiresAt,
    };
    if (await this.deps.store.swapRunGrantToken(grantId, next, held?.turn ?? 0)) return got.accessToken;
    await root.endRunToken(got.refreshToken);
    if ((await this.deps.store.getRunGrant(grantId))?.state !== 'live') throw new Error(`run ${grant.runId} ended while its token was got, so the token was handed back`);
    throw new Error(`run ${grant.runId}'s token under ${key} was changed by someone else while this one was got, so this one was handed back`);
  }

  private async end(grantId: string): Promise<void> {
    const { root } = this.deps;
    for (const held of await this.deps.store.getRunGrantTokens(grantId)) {
      if ('none' in root) throw new Error(`${root.none}, yet run grant ${grantId} holds a token`);
      await root.endRunToken(decryptValue(held.refresh, this.deps.dataKey)).catch(revokedUnlessRefused);
      await this.deps.store.dropRunGrantToken(grantId, held.key);
    }
  }

  ended(grantId: string): Promise<boolean> {
    return keepTrying(`root has not revoked run ${grantId}'s token yet`, () => this.end(grantId), this.deps.log,
      (reason) => this.deps.refusals.refused('root', `revoking run ${grantId}'s token: ${reason}`), this.deps.again?.() ?? reopening());
  }

  async endLeftovers(): Promise<number> {
    let ending = 0;
    for (const grantId of await this.deps.store.getRunGrantsHoldingTokens()) {
      if ((await this.deps.store.getRunGrant(grantId))?.state === 'live') continue;
      ending += 1;
      await this.ended(grantId);
    }
    return ending;
  }
}
