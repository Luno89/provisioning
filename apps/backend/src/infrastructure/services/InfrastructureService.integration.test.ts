import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

describe('applying and destroying a stack keeps its Terraform state in the state folder', () => {
  let places: { cdktfDir: string; stateDir: string };
  let calls: string;

  beforeAll(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'infra-state-'));
    places = { cdktfDir: path.join(root, 'cdktf-infra'), stateDir: path.join(root, 'data', 'terraform') };
    calls = path.join(root, 'calls');
    await mkdir(places.cdktfDir, { recursive: true });
    await writeFile(path.join(bin, 'npx'), [
      '#!/bin/sh',
      `printf '%s|%s|%s\\n' "$PWD" "$CDKTF_STATE_DIR" "$*" >> '${calls}'`,
      'stack="$3"',
      '[ "$2" = deploy ] && echo applied > "$CDKTF_STATE_DIR/terraform.$stack.tfstate"',
      '[ "$2" = destroy ] && echo emptied > "$CDKTF_STATE_DIR/terraform.$stack.tfstate"',
      'exit 0',
      '',
    ].join('\n'));
    await chmod(path.join(bin, 'npx'), 0o755);
  });

  it('runs CDKTF from its project with its output and state in the state folder, which it makes', async () => {
    const service = new InfrastructureService(undefined, places);
    await service.deploy('desk', { logFile: path.join(places.stateDir, '..', 'desk.log') });
    await service.destroy('desk', { logFile: path.join(places.stateDir, '..', 'desk.log') });
    const [deployed, destroyed] = (await readFile(calls, 'utf8')).trim().split('\n');
    const output = path.join(places.stateDir, 'cdktf.out');
    expect(deployed).toBe(`${places.cdktfDir}|${places.stateDir}|cdktf deploy desk --auto-approve --output ${output}`);
    expect(destroyed).toBe(`${places.cdktfDir}|${places.stateDir}|cdktf destroy desk --auto-approve --output ${output}`);
    expect(await readFile(path.join(places.stateDir, 'terraform.desk.tfstate'), 'utf8')).toBe('emptied\n');
  });

  it('moves a stack\'s state from where it was kept before into the state folder before using it, once', async () => {
    await writeFile(path.join(places.cdktfDir, 'terraform.shelf.tfstate'), 'from before\n');
    await writeFile(path.join(places.cdktfDir, 'terraform.shelf.tfstate.backup'), 'backup from before\n');
    await writeFile(path.join(bin, 'npx'), '#!/bin/sh\nexit 0\n');
    await new InfrastructureService(undefined, places).deploy('shelf', { logFile: path.join(places.stateDir, '..', 'shelf.log') });
    expect(await readFile(path.join(places.stateDir, 'terraform.shelf.tfstate'), 'utf8')).toBe('from before\n');
    expect(await readFile(path.join(places.stateDir, 'terraform.shelf.tfstate.backup'), 'utf8')).toBe('backup from before\n');
    expect(existsSync(path.join(places.cdktfDir, 'terraform.shelf.tfstate'))).toBe(false);

    await writeFile(path.join(places.cdktfDir, 'terraform.shelf.tfstate'), 'stale\n');
    await new InfrastructureService(undefined, places).deploy('shelf', { logFile: path.join(places.stateDir, '..', 'shelf.log') });
    expect(await readFile(path.join(places.stateDir, 'terraform.shelf.tfstate'), 'utf8')).toBe('from before\n');
  });
});
