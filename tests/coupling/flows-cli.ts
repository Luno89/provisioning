import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { commitOf, OUT, ROOT } from './artifacts.js';
import { CONCEPTS } from './concepts.js';
import { conceptIndex, flowDiff, flowFrom, mermaidOf, snapshotOf, touchesIn, type FlowSpec, type Snapshot } from './flows.js';
import { changesText, flowsPage } from './flows-page.js';
import { repoGraph } from './repo-graph.js';
import { WORKSPACES } from './workspaces.js';

const args = process.argv.slice(2);
const value = (flag: string) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const out = resolve(value('--out') ?? join(OUT, 'flows'));
const against = value('--against');
mkdirSync(out, { recursive: true });

const specs = JSON.parse(readFileSync(join(ROOT, 'tests', 'coupling', 'flows.json'), 'utf8')) as FlowSpec[];
const graph = repoGraph(ROOT, WORKSPACES, { withinFiles: true });
const touches = touchesIn(graph, (file) => {
  const path = join(ROOT, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}, CONCEPTS);
const flows = specs.map((spec) => flowFrom(graph, spec, touches));
const index = Object.fromEntries(CONCEPTS.map((concept) => [concept.id, conceptIndex(graph, touches, concept.id)]));
const snapshot = snapshotOf(graph, commitOf(), flows, index);
const before = against ? JSON.parse(readFileSync(resolve(against), 'utf8')) as Snapshot : undefined;
const changes = before ? flowDiff(before, snapshot) : undefined;

writeFileSync(join(out, 'snapshot.json'), `${JSON.stringify(snapshot, null, 1)}\n`);
for (const name of Object.keys(snapshot.flows)) writeFileSync(join(out, `${name}.mmd`), `${mermaidOf(snapshot.flows[name]!.files, {})}\n`);
writeFileSync(join(out, 'flows.html'), flowsPage(snapshot, index, changes));
if (changes) writeFileSync(join(out, 'changes.txt'), `${changesText(changes)}\n`);

for (const flow of flows) {
  console.log(`${flow.title}: ${snapshot.flows[flow.name]!.files.files.length} files${flow.missing.length > 0 ? `, entry not found: ${flow.missing.join(', ')}` : ''}`);
  for (const ending of flow.endings) {
    const where = ending.meets.length > 0 ? `meets the flow at ${ending.meets.join('; ')}` : 'MEETS THE FLOW NOWHERE';
    console.log(`  ends: ${ending.title}: ${where}${ending.missing.length > 0 ? `, entry not found: ${ending.missing.join(', ')}` : ''}`);
  }
}
for (const [concept, implementations] of Object.entries(snapshot.concepts)) console.log(`${concept}: ${implementations.length} functions`);
if (changes) console.log(`\n${changesText(changes)}`);
console.log(`\nwritten to ${out}`);
const missing = flows.filter((flow) => flow.missing.length > 0 || flow.endings.some((ending) => ending.missing.length > 0 || ending.meets.length === 0));
if (missing.length > 0) process.exitCode = 1;
