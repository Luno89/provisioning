import { failureContext, type Leaf, type LeafAttempt } from './leaves.js';

export function buildAttemptContext(leaf: Pick<Leaf, 'title' | 'body'>, priorFailures: LeafAttempt[]): string {
  const parts = [`Task: ${leaf.title}`];
  if (leaf.body) parts.push(leaf.body);

  const failures = failureContext(priorFailures);
  if (failures) parts.push(failures);

  return parts.join('\n\n');
}
