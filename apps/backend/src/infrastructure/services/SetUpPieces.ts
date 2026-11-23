import { PROVISION_PIECES, type ProvisionPieceKey } from '@koala/engine-core/koala-install';
import type { Watching } from '../../platform/index.js';
import { piecesUp, type ProvisioningRecord } from '../lib/provisioning.js';
import type { InfrastructureStore } from '../store.js';

export const NO_CLUSTER_OF_ITS_OWN = 'this Koala names no machine and is on no pool, so it has no cluster of its own to set up';

export interface WhenPieceUp {
  whenUp(piece: ProvisionPieceKey, what: string, start: () => void): void;
}

export type SetUpPiecesOf = { store: Pick<InfrastructureStore, 'getProvisioning' | 'watchProvisioning'>; clusterId: string } | { off: string };

const titleOf = (piece: ProvisionPieceKey): string => PROVISION_PIECES.find((entry) => entry.key === piece)?.title ?? piece;

export class SetUpPieces implements WhenPieceUp {
  private readonly up = new Set<ProvisionPieceKey>();
  private readonly heardUp = new Set<string>();
  private readonly starts = new Map<ProvisionPieceKey, (() => void)[]>();
  private watching: Watching | undefined;

  constructor(private readonly of: SetUpPiecesOf, private readonly log: (line: string) => void) {}

  async follow(): Promise<void> {
    if ('off' in this.of || this.watching) return;
    const { store, clusterId } = this.of;
    this.watching = store.watchProvisioning((record) => this.heard(record));
    await this.watching.ready;
    const latest = (await store.getProvisioning(clusterId)).filter((record) => this.ours(record)).at(-1);
    if (latest) this.heard(latest);
  }

  async close(): Promise<void> {
    await this.watching?.close();
    this.watching = undefined;
  }

  whenUp(piece: ProvisionPieceKey, what: string, start: () => void): void {
    if ('off' in this.of) {
      this.log(`[setup] ${what} does not start, since ${titleOf(piece)} is never set up here: ${this.of.off}`);
      return;
    }
    this.starts.set(piece, [...(this.starts.get(piece) ?? []), start]);
    if (this.up.has(piece)) {
      start();
      return;
    }
    this.log(`[setup] ${what} waits for ${titleOf(piece)} to be set up`);
  }

  private ours(record: ProvisioningRecord): boolean {
    return !('off' in this.of) && record.target.kind === 'koala' && record.target.clusterId === this.of.clusterId;
  }

  private heard(record: ProvisioningRecord): void {
    if (!this.ours(record)) return;
    for (const piece of piecesUp(record)) {
      const key = `${record.id}/${piece}`;
      if (this.heardUp.has(key)) continue;
      this.heardUp.add(key);
      this.up.add(piece);
      for (const start of this.starts.get(piece) ?? []) start();
    }
  }
}
