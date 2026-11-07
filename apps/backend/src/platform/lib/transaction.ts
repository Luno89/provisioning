import type { ClientSession } from 'mongodb';

export interface Tx {
  readonly session?: ClientSession | undefined;
}

export const NO_TX: Tx = {};

export const sessionOf = (tx: Tx | undefined): { session?: ClientSession } => (tx?.session ? { session: tx.session } : {});
