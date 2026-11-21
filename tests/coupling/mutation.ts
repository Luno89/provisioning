import type { Evidence, Layer } from '@koala/coupling';
import type { Unit } from './graph.js';

export interface Mutant { id: string; status: string; coveredBy?: string[]; killedBy?: string[]; location?: { start: { line: number; column: number } }; mutatorName?: string; replacement?: string }

export interface MutationReport {
  files: Record<string, { mutants: Mutant[] }>;
  testFiles?: Record<string, { tests: Array<{ id: string; name: string }> }> | undefined;
}

export const AREAS: Record<string, { workspace: string; report: string }> = {
  provision: { workspace: 'packages/provision', report: 'tests/.coupling/mutation/provision.json' },
  'infrastructure-lib': { workspace: 'apps/backend', report: 'tests/.coupling/mutation/infrastructure-lib.json' },
  'accounts-services': { workspace: 'apps/backend', report: 'tests/.coupling/mutation/accounts-services.json' },
  'engine-services': { workspace: 'apps/backend', report: 'tests/.coupling/mutation/engine-services.json' },
};

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

export interface Unchecked { survived: number; examples: string[] }

const EXAMPLES = 3;

export function survivorsIn(report: MutationReport, workspace: string, units: readonly Unit[]): Record<string, Unchecked> {
  const byFile = new Map<string, Unit[]>();
  for (const unit of units) if (unit.ends) byFile.set(unit.file, [...(byFile.get(unit.file) ?? []), unit]);
  const found: Record<string, Unchecked> = {};
  for (const [file, { mutants }] of Object.entries(report.files)) {
    const inFile = byFile.get(`${workspace}/${file}`) ?? [];
    for (const mutant of mutants) {
      const line = mutant.location?.start.line;
      if (mutant.status !== 'Survived' || line === undefined) continue;
      const around = inFile.filter((unit) => unit.line <= line && line <= unit.ends!.line);
      const innermost = around.reduce<Unit | undefined>((best, unit) => (!best || unit.ends!.line - unit.line < best.ends!.line - best.line ? unit : best), undefined);
      if (!innermost) continue;
      const kept = found[innermost.id] ?? { survived: 0, examples: [] };
      kept.survived += 1;
      if (kept.examples.length < EXAMPLES) kept.examples.push(`line ${line}: ${mutant.mutatorName ?? 'a change'} → ${mutant.replacement ?? '?'}`);
      found[innermost.id] = kept;
    }
  }
  return found;
}

