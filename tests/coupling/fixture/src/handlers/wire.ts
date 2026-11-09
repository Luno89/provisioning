import { makeCore } from './core.js';
import { use } from './consumer.js';

export function wire(): string {
  const { lookup } = makeCore();
  return use({ find: lookup });
}

export function wireThrough(): string {
  const core = makeCore();
  return use({ find: core.lookup });
}
