import { describe, expect, it } from 'vitest';
import { restoreRunNames, restoreRunStamp } from './restore-lab.js';

describe('what one restore drill names', () => {
  it('names every container, VM, workflow and account it makes after its own run, so two drills never touch each other\'s', () => {
    const one = restoreRunNames(restoreRunStamp(1_793_000_000_000, 'a1b2'));
    const two = restoreRunNames(restoreRunStamp(1_793_000_000_000, 'c3d4'));
    const named = (names: ReturnType<typeof restoreRunNames>) => [names.minio, names.probe, names.firstRoot, names.secondRoot, names.workflow, names.email, names.instanceId, names.backupUser];
    for (const name of named(one)) expect(name).toContain(one.stamp);
    expect(named(one).filter((name) => named(two).includes(name))).toEqual([]);
    expect(one.minio).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
    expect(one.probe).toMatch(/^[a-z0-9-]{1,63}$/);
    expect(one.backupUser.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses a stamp that would make a name Docker, Tailscale or MinIO refuses', () => {
    expect(() => restoreRunNames('Has Space')).toThrow(/not a run stamp/);
    expect(() => restoreRunNames('x')).toThrow(/not a run stamp/);
    expect(restoreRunStamp(1_793_000_000_000, 'AB12')).toBe(restoreRunStamp(1_793_000_000_000, 'ab12'));
  });
});
