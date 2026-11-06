import { ROOT } from './artifacts.js';
import { referencesOf } from './refs.js';
import { WORKSPACES } from './workspaces.js';

const REFERENCE_CONFIGS = [
  ...WORKSPACES.map((workspace) => `${workspace.folder}/${workspace.tsconfig}`),
  'apps/frontend/tsconfig.integration.json',
  'tests/tsconfig.json',
];

const [file, symbol] = process.argv.slice(2);
if (!file || !symbol) throw new Error('usage: npm run refs -- <file> <Symbol or Type.member>');
const started = Date.now();
const references = referencesOf(ROOT, REFERENCE_CONFIGS, file, symbol);
for (const reference of references) console.log(`${reference.file}:${reference.line}:${reference.column}  ${reference.kind.padEnd(11)}  ${reference.text}`);
console.log(`${references.length} references to ${symbol} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
