import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InfrastructureService } from './InfrastructureService.js';

let bin: string;
let savedPath: string | undefined;

beforeAll(async () => {
  bin = await mkdtemp(path.join(tmpdir(), 'infra-bin-'));
  await writeFile(path.join(bin, 'docker'), '#!/bin/sh\n[ "$1" = inspect ] && exit 0\necho "kubectl is not there" >&2\nexit 1\n');
  await chmod(path.join(bin, 'docker'), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ''}`;
});

afterAll(async () => {
  process.env.PATH = savedPath;
  await rm(bin, { recursive: true, force: true });
});

describe('applying a manifest through a cluster\'s kubectl', () => {
  it('fails with what kubectl said when it exits before reading the manifest, rather than taking the process down', async () => {
    const manifest = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: big\ndata:\n  value: "${'x'.repeat(4 * 1024 * 1024)}"\n`;
    await expect(new InfrastructureService().applyManifest(manifest, '/tmp/kubeconfig-nowhere-at-all')).rejects.toThrow('kubectl apply failed: kubectl is not there');
  });
});
