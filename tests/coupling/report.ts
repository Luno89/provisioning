import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGraph } from './graph.js';
import type { Ran } from './collect.js';
import { judge, type Judged, type Level } from './join.js';

const OPENS_SOMETHING = /testDatabase|testPayloadBlobs|temporalTestEnvironment|TestWorkflowEnvironment|mountRouter|createServer|\bspawn\(|spawnSync|execFile|socket\.io-client|new Server\(/;

export function levelFrom(root: string): (testFile: string) => Level {
  const seen = new Map<string, Level>();
  return (testFile) => {
    if (!seen.has(testFile)) {
      const text = readFileSync(join(root, testFile), 'utf8');
      seen.set(testFile, /-live\.ts$/.test(testFile) ? 'live' : OPENS_SOMETHING.test(text) ? 'component' : 'unit');
    }
    return seen.get(testFile)!;
  };
}

export function runsIn(dir: string): Ran[] {
  return readdirSync(dir).filter((file) => file.endsWith('.json')).map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as Ran);
}

export function summary(judged: readonly Judged[], unitName: (id: string) => string): string {
  const lines: string[] = [];
  const crossing = judged.filter((entry) => entry.crosses === 'area');
  const count = (list: readonly Judged[], test: (entry: Judged) => boolean) => list.filter(test).length;
  lines.push(`${judged.length} edges, ${crossing.length} between areas`);
  lines.push(`  covered for real by some test: ${count(judged, (entry) => entry.covered.length > 0)} of ${judged.length}`);
  lines.push(`  between areas, covered: ${count(crossing, (entry) => entry.covered.length > 0)}; also with its caller: ${count(crossing, (entry) => entry.withCallerAt !== undefined)}`);
  lines.push(`  no real implementation found: ${count(judged, (entry) => entry.edge.to.length === 0)}`);
  const gaps = crossing.filter((entry) => entry.covered.length === 0 && entry.edge.to.length > 0);
  const byFile = new Map<string, Judged[]>();
  for (const gap of gaps) byFile.set(gap.edge.site.file, [...(byFile.get(gap.edge.site.file) ?? []), gap]);
  lines.push(`between-area edges no test runs for real, by file (${gaps.length}):`);
  for (const [file, list] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`  ${file} (${list.length})`);
    for (const gap of list.slice(0, 4)) lines.push(`    :${gap.edge.site.line} ${unitName(gap.edge.from)} → ${gap.edge.to.map(unitName).join(' | ')}`);
  }
  return lines.join('\n');
}

if (process.argv[1]?.endsWith('report.ts')) {
  const [root, dir, area] = process.argv.slice(2);
  if (!root || !dir || !area) throw new Error('usage: report.ts <workspace root> <coverage dir> <area>');
  const graph = buildGraph({ tsconfig: join(root, 'tsconfig.json'), root, calledFrom: (file) => file.startsWith(`src/${area}/`) && !/\.test\.ts$/.test(file) });
  const judged = judge(graph, runsIn(dir), levelFrom(root));
  const name = (id: string) => { const unit = graph.units[id]; return unit ? `${unit.file.replace(/^src\//, '')}#${unit.name}` : id; };
  console.log(summary(judged, name));
}
