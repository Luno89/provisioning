import type { CompactionConfig } from '@koala/harness-types';

export type { CompactionConfig };

export interface ExtendedCompactionConfig extends CompactionConfig {
  /** Payload byte threshold above which historical tool write calls are elided to receipts. Default: 400 */
  elidePayloadAboveBytes: number;
  /** Maximum number of findings/discoveries extracted into the continuity state vector. Default: 8 */
  maxDiscoveries: number;
  /** Maximum characters per discovery summary in the continuity state vector. Default: 240 */
  discoveryChars: number;
  /** Maximum characters for the primary task goal in the continuity state vector. Default: 1200 */
  goalChars: number;
}

export const DEFAULT_COMPACTION_CONFIG: Readonly<ExtendedCompactionConfig> = {
  softThreshold: 0.65,
  hardThreshold: 0.78,
  criticalThreshold: 0.90,
  liveTailTurns: 6,
  preserveHeadTurns: 2,
  maxOutputChars: 30_000,
  outputHeadRatio: 0.20,
  memoryChars: 6000,
  maxBranchMessages: 200,
  reasoningKeptTurns: 6,
  elidePayloadAboveBytes: 400,
  maxDiscoveries: 8,
  discoveryChars: 240,
  goalChars: 1200,
};

export function createCompactionConfig(overrides?: Partial<ExtendedCompactionConfig>): ExtendedCompactionConfig {
  return {
    ...DEFAULT_COMPACTION_CONFIG,
    ...Object.fromEntries(
      Object.entries(overrides ?? {}).filter(([_, v]) => v !== undefined && v !== null)
    ),
  } as ExtendedCompactionConfig;
}
