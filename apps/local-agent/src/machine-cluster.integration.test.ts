import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostCluster, wantedFile } from './machine-cluster.js';

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'machine-cluster-host-'));
  made.push(dir);
  return dir;
};

describe('the machine as its cluster sees it', () => {
  it('keeps that its cluster should run in a file under the person\'s data folder, which a restarted agent reads again', async () => {
    const data = folder();
    const wanted = wantedFile({ XDG_DATA_HOME: data });
    expect(wanted).toBe(join(data, 'koala', 'cluster-wanted'));
    const before = hostCluster(async () => undefined, { wantedAt: wanted });
    expect(await before.isWanted()).toBe(false);
    await before.wanted(true);
    expect(existsSync(wanted)).toBe(true);
    expect(await hostCluster(async () => undefined, { wantedAt: wanted }).isWanted()).toBe(true);
    await before.wanted(false);
    await before.wanted(false);
    expect(await hostCluster(async () => undefined, { wantedAt: wanted }).isWanted()).toBe(false);
  });

  it('runs real programs, reads real files, and asks the mesh for its address', async () => {
    const dir = folder();
    const config = join(dir, 'k3s.yaml');
    writeFileSync(config, 'server: https://127.0.0.1:6443\n');
    const host = hostCluster(async () => '100.64.0.7', { wantedAt: join(dir, 'wanted') });
    expect(await host.run(process.execPath, ['-e', 'process.stdout.write("active")'])).toBe('active');
    await expect(host.run(process.execPath, ['-e', 'process.exit(3)'])).rejects.toThrow();
    expect(await host.exists(config)).toBe(true);
    expect(await host.exists(join(dir, 'nothing'))).toBe(false);
    expect(await host.read(config)).toBe('server: https://127.0.0.1:6443\n');
    expect(await host.meshIp()).toBe('100.64.0.7');
    const before = host.now();
    await host.pause(5);
    expect(host.now()).toBeGreaterThanOrEqual(before + 5);
  });
});
