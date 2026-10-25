import { resolve } from 'node:path';
import { ignoredRefusal, leaksRefusal, pushedRange, pushRefusal } from './lib/gates.js';
import { git, ignoredIn, leaksIn, pushedGates } from './lib/gate-runs.js';

const REPO = resolve(new URL('.', import.meta.url).pathname, '..');
const [ref, pushed, remote] = process.argv.slice(2);
if (!ref || !pushed) {
  console.error('usage: gate-check.ts <remote ref> <local sha> [<remote sha>]');
  process.exit(2);
}
const commit = git(REPO, ['rev-parse', `${pushed}^{commit}`]);
const refusal = ignoredRefusal(ignoredIn(REPO, commit)) ?? leaksRefusal(leaksIn(REPO, pushedRange(remote, commit))) ?? pushRefusal(ref, pushedGates(REPO, commit));
if (refusal) {
  console.error(`pre-push: ${ref.replace(/^refs\/(heads|tags)\//, '')} refused: ${refusal}`);
  process.exit(1);
}
