import type { Evidence, Judgement, Layer } from '@koala/coupling';

export interface KnownFault { file: string; name: string; what: string; fixedIn: string }

export type FaultRank =
  | { fault: KnownFault; found: true; rank: number; ofAll: number; percentile: number; runAt: Layer[] }
  | { fault: KnownFault; found: false };

export interface Backtest { faults: FaultRank[]; judged: number; inRiskierHalf: number }

export function backtest(judgement: Judgement, faults: readonly KnownFault[]): Backtest {
  const ofAll = judgement.functions.length;
  const ranked = faults.map((fault): FaultRank => {
    const at = judgement.functions.findIndex((unit) => unit.file === fault.file && unit.name === fault.name);
    if (at < 0) return { fault, found: false };
    const rank = at + 1;
    return { fault, found: true, rank, ofAll, percentile: Math.round(((ofAll - rank + 1) / ofAll) * 100), runAt: judgement.functions[at]!.runAt };
  });
  const found = ranked.filter((entry): entry is Extract<FaultRank, { found: true }> => entry.found);
  return { faults: ranked, judged: found.length, inRiskierHalf: found.filter((entry) => entry.rank <= ofAll / 2).length };
}

export function faultEvidence(result: Backtest): Evidence[] {
  return result.faults.flatMap((entry) => (entry.found ? entry.runAt.map((layer): Evidence => ({ layer, caught: false })) : []));
}
