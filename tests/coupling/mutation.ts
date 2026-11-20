import type { Evidence, Layer } from '@koala/coupling';

export interface Mutant { id: string; status: string; coveredBy?: string[]; killedBy?: string[] }

export interface MutationReport {
  files: Record<string, { mutants: Mutant[] }>;
  testFiles?: Record<string, { tests: Array<{ id: string; name: string }> }> | undefined;
}

const JUDGED = new Set(['Killed', 'Survived', 'Timeout']);

export function evidenceOf(report: MutationReport, layerOf: (testFile: string) => Layer): Evidence[] {
  const layerOfTest = new Map<string, Layer>();
  for (const [file, { tests }] of Object.entries(report.testFiles ?? {})) for (const test of tests) layerOfTest.set(test.id, layerOf(file));
  const evidence: Evidence[] = [];
  for (const { mutants } of Object.values(report.files)) {
    for (const mutant of mutants) {
      if (!JUDGED.has(mutant.status)) continue;
      const ranAgainst = mutant.coveredBy?.length ? mutant.coveredBy : [...layerOfTest.keys()];
      const killers = new Set((mutant.killedBy ?? []).map((id) => layerOfTest.get(id)));
      const layers = [...new Set(ranAgainst.map((id) => layerOfTest.get(id)).filter((layer): layer is Layer => layer !== undefined))];
      for (const layer of layers) evidence.push({ layer, caught: mutant.status === 'Timeout' || killers.has(layer) });
    }
  }
  return evidence;
}

export interface KeptRun { area: string; commit: string; at: string; layers: Partial<Record<Layer, { caught: number; missed: number }>> }

export function recordOf(evidence: readonly Evidence[], area: string, commit: string, at: string): KeptRun {
  const layers: KeptRun['layers'] = {};
  for (const seen of evidence) {
    const counts = layers[seen.layer] ?? { caught: 0, missed: 0 };
    if (seen.caught) counts.caught += 1; else counts.missed += 1;
    layers[seen.layer] = counts;
  }
  return { area, commit, at, layers };
}

const DAY_MS = 86_400_000;

export function evidenceFrom(kept: readonly KeptRun[], now: number): Evidence[] {
  return kept.flatMap((run) => {
    const age = (now - Date.parse(run.at)) / DAY_MS;
    return Object.entries(run.layers).flatMap(([layer, counts]) => [
      ...Array.from({ length: counts?.caught ?? 0 }, () => ({ layer: layer as Layer, caught: true, age })),
      ...Array.from({ length: counts?.missed ?? 0 }, () => ({ layer: layer as Layer, caught: false, age })),
    ]);
  });
}
