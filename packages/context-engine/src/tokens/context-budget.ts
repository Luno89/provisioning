import type { CompactionConfig } from '../config.js';

export interface BudgetContextParams {
  windowTokens: number;
  marginTokens?: number | undefined;
  minReplyTokens?: number | undefined;
}

export type CompactionPhase = 'normal' | 'soft_mask' | 'hard_compact' | 'critical_reset';

/**
 * Calculates context window pressure (0.0 to 1.0+).
 */
export function calculatePressure(
  promptTokens: number,
  params: BudgetContextParams,
): number {
  const margin = params.marginTokens ?? 512;
  return Math.min(1.5, (promptTokens + margin) / Math.max(1, params.windowTokens));
}

/**
 * Calculates remaining token headroom for reply generation.
 */
export function remainingHeadroom(
  promptTokens: number,
  params: BudgetContextParams,
): number {
  const margin = params.marginTokens ?? 512;
  const minReply = params.minReplyTokens ?? 512;
  const available = params.windowTokens - promptTokens - margin;
  return Math.max(minReply, available);
}

/**
 * Fits a requested reply token ceiling into available context window room.
 */
export function fitReplyCeiling(
  ceiling: number,
  promptTokens: number,
  params: BudgetContextParams,
): number {
  const available = remainingHeadroom(promptTokens, params);
  return Math.max(params.minReplyTokens ?? 512, Math.min(ceiling, available));
}

/**
 * Determines which compaction phase should be active given the current pressure and thresholds.
 *
 * Discrete phases avoid continuous context rewriting, keeping the prompt prefix stable
 * for maximal KV-cache hit rates.
 */
export function evalCompactionPhase(
  pressure: number,
  config: Pick<CompactionConfig, 'softThreshold' | 'hardThreshold' | 'criticalThreshold'>,
): CompactionPhase {
  if (pressure >= config.criticalThreshold) return 'critical_reset';
  if (pressure >= config.hardThreshold) return 'hard_compact';
  if (pressure >= config.softThreshold) return 'soft_mask';
  return 'normal';
}
