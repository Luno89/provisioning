import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mainHeads } from '../../hub/services/HubRepoSync.js';
import { ClusterAccess } from '../../infrastructure/services/ClusterAccess.js';
import { InfrastructureService, terraformPlacesFor } from '../../infrastructure/services/InfrastructureService.js';
import { KEY_NAMES } from '../lib/keys.js';
import { nodeProcesses, nodeStreams } from './processes.js';

const KEYS = Object.values(KEY_NAMES);
const dir = mkdtempSync(join(tmpdir(), 'koala-child-env-'));
const bin = join(dir, 'bin');

const printsNames = (name: string, to: 'out' | 'err', code: number): string => {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\nenv | cut -d= -f1 ${to === 'err' ? '>&2' : ''}\nexit ${code}\n`);
  chmodSync(file, 0o755);
  return file;
};

const namesIn = (said: string): string[] => said.split('\n').map((line) => line.trim()).filter(Boolean);

describe('what a child process of the backend is handed', () => {
  const before: Record<string, string | undefined> = {};

  beforeAll(() => {
    mkdirSync(bin, { recursive: true });
    for (const name of [...KEYS, 'PATH']) before[name] = process.env[name];
    for (const name of KEYS) process.env[name] = `${name.toLowerCase()}-never-handed-on-to-a-child-process`;
    process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('gives helm no platform key', async () => {
    const helm = printsNames('helm', 'out', 0);
    const access = new ClusterAccess({ here: { root: false }, folder: dir, processes: nodeProcesses, streams: nodeStreams, tools: { kubectl: helm, helm } });
    const names = namesIn(await access.helm({ clusterId: 'desk', kind: 'machine', kubeconfig: 'apiVersion: v1\n' }, ['version']));
    expect(names).toContain('PATH');
    for (const key of KEYS) expect(names).not.toContain(key);
  });

  it('gives terraform no platform key', async () => {
    const terraform = printsNames('terraform', 'out', 0);
    const infra = new InfrastructureService(terraformPlacesFor({ kind: 'local' }, mkdtempSync(join(dir, 'data-'))));
    const names = namesIn((await infra.runCommand(terraform, ['plan'], 'child-env', { env: { CD_DIR: dir } })).stdout);
    expect(names).toContain('PATH');
    for (const key of KEYS) expect(names).not.toContain(key);
  });

  it('gives git no platform key', async () => {
    printsNames('git', 'err', 1);
    const said = await mainHeads({ url: 'http://127.0.0.1:9/owner.git' }, { url: 'http://127.0.0.1:9/hub.git' }).then(() => 'answered', (err: Error) => err.message);
    const names = namesIn(said);
    expect(names).toContain('GIT_TERMINAL_PROMPT');
    for (const key of KEYS) expect(names).not.toContain(key);
  });
});
