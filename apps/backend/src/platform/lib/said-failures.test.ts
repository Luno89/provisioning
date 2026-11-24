import { describe, expect, it } from 'vitest';
import { saidFailures } from './said-failures.js';

describe('a process that says which dependency did not answer it', () => {
  it('says the dependency and why, and hands the failure on unchanged for its caller to judge', () => {
    const said: string[] = [];
    const failure = new Error('it refused the connection (ECONNREFUSED)');
    const handed = saidFailures('the engine worker', (line) => said.push(line)).failed('root', failure);

    expect(handed).toBe(failure);
    expect(said).toEqual(['root did not answer the engine worker: it refused the connection (ECONNREFUSED)']);
  });
});
