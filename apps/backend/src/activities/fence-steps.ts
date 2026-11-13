import { fenceHeldEverywhere, type Closing, type PlatformStore } from '../platform/index.js';

export type FenceRecords = Pick<PlatformStore, 'raiseFence' | 'confirmFence' | 'fenceAcks' | 'watchFenceAcks' | 'processesSeenSince' | 'watchProcesses'>;

export async function raiseAndHold(store: FenceRecords, closing: Closing, now: () => number): Promise<string[]> {
  await store.raiseFence(closing, new Date(now()).toISOString());
  const heldBy = await fenceHeldEverywhere({ store, now }, closing);
  await store.confirmFence(closing);
  return heldBy;
}
