import { describe, expect, it } from 'vitest';
import { platformStoreContract } from './testing/store-contract.js';
import { MemoryPlatformStore } from './testing/memory-store.js';
import { dependencyStateFrom } from './store.js';

platformStoreContract(async () => new MemoryPlatformStore());

describe('a recorded dependency state read back', () => {
  it('keeps a dependency refused for good, with when and why', () => {
    const row = { process: 'backend', dependency: 'root', state: 'refused', since: '2026-11-08T10:00:00.000Z', reason: 'it refused the request (400)', at: '2026-11-08T10:00:00.000Z' };
    expect(dependencyStateFrom(row)).toEqual(row);
  });
});
