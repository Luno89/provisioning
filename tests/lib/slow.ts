import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prunedTo, type Baseline } from '../copies/rules.js';
import { isHeld, layerOverBudget, overBudgetLine, slowTests, type Layer, type TestTime } from './timings.js';

export const SLOW_LIST = join(import.meta.dirname, '..', 'tiers', 'slow.json');
export const SLOW_LIST_FROM = 'KOALA_SLOW_LIST';

export const KNOWN_SLOW = 'known slow, on the list to be fixed';

export const layerKey = (layer: Layer): string => `layer ${layer}`;

export const readSlow = (file: string): Baseline => JSON.parse(readFileSync(file, 'utf8')) as Baseline;

export interface JudgedTests { failing: string[]; known: string[]; printed: string[]; stale: string[] }

export function judgeTests(tests: readonly TestTime[], slow: Baseline, files: readonly string[]): JudgedTests {
  const over = slowTests(tests);
  const overNames = new Set(over.filter((test) => isHeld(test.tier)).map((test) => test.name));
  const held = over.filter((test) => isHeld(test.tier));
  const ran = new Set(files);
  return {
    failing: held.filter((test) => slow[test.name] === undefined).map(overBudgetLine),
    known: held.filter((test) => slow[test.name] !== undefined).map(overBudgetLine),
    printed: over.filter((test) => !isHeld(test.tier)).map(overBudgetLine),
    stale: Object.keys(slow).filter((key) => !key.startsWith('layer ') && ran.has(key.split(' > ')[0] ?? key) && !overNames.has(key)),
  };
}

export interface JudgedLayer { failing?: string; known?: string; stale?: string; printed?: string }

export function judgeLayer(layer: Layer, seconds: number, slow: Baseline): JudgedLayer {
  const over = layerOverBudget(layer, seconds);
  const listed = slow[layerKey(layer)] !== undefined;
  if (over === undefined) return listed ? { stale: layerKey(layer) } : {};
  if (!isHeld(layer)) return { printed: over };
  return listed ? { known: over } : { failing: over };
}

export function prunedSlow(slow: Baseline, stale: readonly string[]): Baseline {
  return prunedTo(slow, Object.fromEntries(Object.keys(slow).filter((key) => !stale.includes(key)).map((key) => [key, 1])));
}
