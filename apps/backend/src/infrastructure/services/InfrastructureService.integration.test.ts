import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, lstat, readlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InfrastructureService, TerraformStopped, type TerraformPlaces } from './InfrastructureService.js';
import { terraformCliConfig } from '../lib/terraform-state.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../');
const TERRAFORM = path.join(REPO, 'bin', 'terraform');
const run = promisify(execFile);

let bin: string;
let savedPath: string | undefined;

beforeAll(async () => {
  bin = await mkdtemp(path.join(tmpdir(), 'infra-bin-'));
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ''}`;
  process.env.CHECKPOINT_DISABLE = '1';
});

afterAll(async () => {
  process.env.PATH = savedPath;
  await rm(bin, { recursive: true, force: true });
});

interface Stand {
  root: string;
  places: TerraformPlaces & { runsDir: string };
  cluster: string;
  capture: string;
}

async function standUp(home: 'local' | 'kubernetes'): Promise<Stand> {
  const root = await mkdtemp(path.join(tmpdir(), 'infra-cdktf-'));
  const cdktfDir = path.join(root, 'app');
  const stateDir = path.join(root, 'data', 'terraform');
  const runsDir = path.join(root, 'runs');
  const cluster = path.join(root, 'cluster');
  const capture = path.join(root, 'cli-config');
  await Promise.all([mkdir(cdktfDir, { recursive: true }), mkdir(runsDir), mkdir(cluster)]);
  await symlink(path.join(REPO, 'node_modules'), path.join(cdktfDir, 'node_modules'));
  const cdktf = createRequire(path.join(REPO, 'packages', 'cdktf-infra', 'package.json')).resolve('cdktf');
  await writeFile(path.join(cdktfDir, 'cdktf.json'), JSON.stringify({ language: 'typescript', app: `${path.join(REPO, 'node_modules', '.bin', 'tsx')} app.ts`, sendCrashReports: 'false', terraformProviders: [] }));
  await writeFile(path.join(cdktfDir, 'app.ts'), [
    'import { readFileSync, writeFileSync } from "node:fs";',
    `import { App, LocalBackend, TerraformResource, TerraformStack } from ${JSON.stringify(cdktf)};`,
    `import { keepState } from ${JSON.stringify(path.join(REPO, 'packages', 'cdktf-infra', 'lib', 'state.ts'))};`,
    'if (process.env.FAIL_SYNTH) throw new Error("the app would not synthesize");',
    `if (process.env.TF_CLI_CONFIG_FILE) writeFileSync(${JSON.stringify(capture)}, readFileSync(process.env.TF_CLI_CONFIG_FILE));`,
    'const app = new App();',
    'for (const id of ["desk", "shelf"]) {',
    '  const stack = new TerraformStack(app, id);',
    '  new TerraformResource(stack, "thing", { terraformResourceType: "terraform_data" }).addOverride("input", process.env.INPUT ?? "one");',
    '  if (process.env.HANG) new TerraformResource(stack, "slow", { terraformResourceType: "terraform_data" }).addOverride("provisioner", [{ "local-exec": { command: "sleep 600" } }]);',
    `  if (process.env.CDKTF_STATE_NAMESPACE) new LocalBackend(stack, { path: ${JSON.stringify(cluster)} + "/" + process.env.CDKTF_STATE_NAMESPACE + "-" + id + ".tfstate" });`,
    '}',
    'if (!process.env.CDKTF_STATE_NAMESPACE) keepState(app, process.env);',
    'app.synth();',
    '',
  ].join('\n'));
  const places = {
    cdktfDir, stateDir, runsDir, mirrorDir: path.join(root, 'no-mirror'),
    home: home === 'local' ? { kind: 'local' as const, dir: stateDir } : { kind: 'kubernetes' as const, namespace: 'koala', dir: stateDir },
  };
  return { root, places, cluster, capture };
}

const resourcesIn = async (file: string): Promise<Array<{ instances: Array<{ attributes: { id: string; input: { value: string } } }> }>> =>
  (JSON.parse(await readFile(file, 'utf8')) as { resources: Array<{ instances: Array<{ attributes: { id: string; input: { value: string } } }> }> }).resources;

describe('applying and destroying a stack with real CDKTF and Terraform', () => {
  let stand: Stand;
  beforeAll(async () => { stand = await standUp('local'); });
  afterAll(async () => { await rm(stand.root, { recursive: true, force: true }); });

  it('keeps its state in the data folder, synthesizes into a folder of the run\'s own and removes it when the run ends', async () => {
    const service = new InfrastructureService(stand.places);
    await mkdir(path.join(stand.places.stateDir, 'cdktf.out', 'stacks', 'desk'), { recursive: true });
    await service.deploy('desk', { logFile: path.join(stand.root, 'desk.log') });
    const state = path.join(stand.places.stateDir, 'terraform.desk.tfstate');
    expect((await resourcesIn(state))[0]?.instances[0]?.attributes.input.value).toBe('one');
    expect(await readdir(stand.places.runsDir)).toEqual([]);
    expect(existsSync(path.join(stand.places.stateDir, 'cdktf.out'))).toBe(false);
    await service.destroy('desk', { logFile: path.join(stand.root, 'desk.log') });
    expect(await resourcesIn(state)).toEqual([]);
    expect(await readdir(stand.places.runsDir)).toEqual([]);
  }, 180_000);

  it('runs two stacks at once, each in its own output, neither touching the other', async () => {
    const service = new InfrastructureService(stand.places);
    await Promise.all([
      service.deploy('desk', { logFile: path.join(stand.root, 'desk.log'), env: { INPUT: 'for the desk' } }),
      service.deploy('shelf', { logFile: path.join(stand.root, 'shelf.log'), env: { INPUT: 'for the shelf' } }),
    ]);
    expect((await resourcesIn(path.join(stand.places.stateDir, 'terraform.desk.tfstate')))[0]?.instances[0]?.attributes.input.value).toBe('for the desk');
    expect((await resourcesIn(path.join(stand.places.stateDir, 'terraform.shelf.tfstate')))[0]?.instances[0]?.attributes.input.value).toBe('for the shelf');
    expect(await readdir(stand.places.runsDir)).toEqual([]);
  }, 180_000);

  it('stops Terraform when told to, saying why, and leaves the stack free for the next run', async () => {
    const service = new InfrastructureService(stand.places);
    const logFile = path.join(stand.root, 'stopped.log');
    const stop = new AbortController();
    const deploying = service.deploy('shelf', { logFile, env: { HANG: '1' }, signal: stop.signal });
    const settled = deploying.then(() => 'applied', (err: unknown) => err);
    while (!(await readFile(logFile, 'utf8').catch(() => '')).includes('local-exec')) {
      if (await Promise.race([settled, new Promise((done) => { setTimeout(() => done(undefined), 200); })])) break;
    }
    const startedAt = Date.now();
    stop.abort(new Error('the person stopped the deploy'));
    const ended = await settled;
    expect(ended).toBeInstanceOf(TerraformStopped);
    expect((ended as Error).message).toBe('Terraform was stopped: the person stopped the deploy');
    expect(Date.now() - startedAt).toBeLessThan(60_000);
    expect(await readFile(logFile, 'utf8')).toContain('STOPPED: the person stopped the deploy');
    expect(await readdir(stand.places.runsDir)).toEqual([]);
    await service.deploy('shelf', { logFile: path.join(stand.root, 'after-stop.log') });
  }, 180_000);

  it('removes the run\'s folder when the run fails too', async () => {
    const service = new InfrastructureService(stand.places);
    await expect(service.deploy('desk', { logFile: path.join(stand.root, 'fail.log'), env: { FAIL_SYNTH: '1' } })).rejects.toThrow();
    expect(await readdir(stand.places.runsDir)).toEqual([]);
  }, 180_000);

  it('hands Terraform the mirror\'s settings when the mirror is there, and none when it is not', async () => {
    await rm(stand.capture, { force: true });
    await new InfrastructureService(stand.places).deploy('shelf', { logFile: path.join(stand.root, 'shelf.log') });
    expect(existsSync(stand.capture)).toBe(false);
    const mirrorDir = path.join(stand.root, 'mirror');
    await mkdir(mirrorDir);
    await new InfrastructureService({ ...stand.places, mirrorDir }).deploy('shelf', { logFile: path.join(stand.root, 'shelf.log') });
    expect(await readFile(stand.capture, 'utf8')).toBe(terraformCliConfig(mirrorDir));
  }, 180_000);

  it('moves a stack\'s state from where it was kept before into the state folder before using it, once', async () => {
    const before = path.join(stand.places.cdktfDir, 'terraform.shelf.tfstate');
    const now = path.join(stand.places.stateDir, 'terraform.shelf.tfstate');
    await rm(now, { force: true });
    await rm(`${now}.backup`, { force: true });
    await new InfrastructureService(stand.places).deploy('shelf', { logFile: path.join(stand.root, 'shelf.log') });
    const made = await readFile(now, 'utf8');
    await rm(now);
    await writeFile(before, made);
    await new InfrastructureService(stand.places).deploy('shelf', { logFile: path.join(stand.root, 'shelf.log') });
    expect(existsSync(before)).toBe(false);
    expect((await resourcesIn(now))[0]?.instances[0]?.attributes.id).toBe((JSON.parse(made) as { resources: Array<{ instances: Array<{ attributes: { id: string } }> }> }).resources[0]?.instances[0]?.attributes.id);
  }, 180_000);
});

describe('moving state kept in the data folder into the backend in the cluster, with real Terraform', () => {
  let stand: Stand;
  beforeAll(async () => { stand = await standUp('kubernetes'); });
  afterAll(async () => { await rm(stand.root, { recursive: true, force: true }); });

  it('pushes the state into the backend before the first run there, removes the file, and the stack carries on with what it had', async () => {
    const local = await standUp('local');
    try {
      await new InfrastructureService(local.places).deploy('desk', { logFile: path.join(local.root, 'desk.log') });
      await mkdir(stand.places.stateDir, { recursive: true });
      const kept = path.join(stand.places.stateDir, 'terraform.desk.tfstate');
      const before = await readFile(path.join(local.places.stateDir, 'terraform.desk.tfstate'), 'utf8');
      await writeFile(kept, before);
      const id = (await resourcesIn(kept))[0]?.instances[0]?.attributes.id;

      await new InfrastructureService(stand.places).deploy('desk', { logFile: path.join(stand.root, 'desk.log') });
      expect(existsSync(kept)).toBe(false);
      expect(existsSync(`${kept}.backup`)).toBe(false);
      const inCluster = path.join(stand.cluster, 'koala-desk.tfstate');
      expect((JSON.parse(await readFile(inCluster, 'utf8')) as { lineage: string }).lineage).toBe((JSON.parse(before) as { lineage: string }).lineage);
      expect((await resourcesIn(inCluster))[0]?.instances[0]?.attributes.id).toBe(id);
      expect(await readdir(stand.places.runsDir)).toEqual([]);

      await new InfrastructureService(stand.places).deploy('desk', { logFile: path.join(stand.root, 'desk.log'), env: { INPUT: 'changed' } });
      expect((await resourcesIn(inCluster))[0]?.instances[0]?.attributes.input.value).toBe('changed');
    } finally {
      await rm(local.root, { recursive: true, force: true });
    }
  }, 300_000);

  it('refuses, keeping the file, when the backend already holds a state that the file did not lead to', async () => {
    await new InfrastructureService(stand.places).deploy('shelf', { logFile: path.join(stand.root, 'shelf.log') });
    const unrelated = await standUp('local');
    try {
      await new InfrastructureService(unrelated.places).deploy('shelf', { logFile: path.join(unrelated.root, 'shelf.log') });
      const kept = path.join(stand.places.stateDir, 'terraform.shelf.tfstate');
      await writeFile(kept, await readFile(path.join(unrelated.places.stateDir, 'terraform.shelf.tfstate'), 'utf8'));
      await expect(new InfrastructureService(stand.places).deploy('shelf', { logFile: path.join(stand.root, 'shelf.log') }))
        .rejects.toThrow(/shelf has a state in the data folder and another in the cluster/);
      expect(existsSync(kept)).toBe(true);
      expect(await readdir(stand.places.runsDir)).toEqual([]);
    } finally {
      await rm(unrelated.root, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('installing providers from the mirror with real Terraform', () => {
  it('takes a pinned provider from the mirror with the registry unreachable, linking it rather than copying it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'infra-mirror-'));
    try {
      const platform = `${process.platform}_${process.arch === 'x64' ? 'amd64' : process.arch}`;
      const place = path.join(root, 'mirror', 'registry.terraform.io', 'hashicorp', 'kubernetes', '2.38.0', platform);
      await mkdir(place, { recursive: true });
      await writeFile(path.join(place, 'terraform-provider-kubernetes_v2.38.0_x5'), '#!/bin/sh\nexit 1\n');
      await chmod(path.join(place, 'terraform-provider-kubernetes_v2.38.0_x5'), 0o755);
      await writeFile(path.join(root, 'terraform.rc'), terraformCliConfig(path.join(root, 'mirror')));
      const work = path.join(root, 'stack');
      await mkdir(work);
      await writeFile(path.join(work, 'main.tf.json'), JSON.stringify({ terraform: { required_providers: { kubernetes: { source: 'hashicorp/kubernetes', version: '~> 2.0' } } } }));
      const env = { ...process.env, TF_CLI_CONFIG_FILE: path.join(root, 'terraform.rc'), HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', TF_IN_AUTOMATION: 'true' };
      const { stdout } = await run(TERRAFORM, ['init', '-input=false', '-no-color'], { cwd: work, env });
      expect(stdout).toContain('Installed hashicorp/kubernetes v2.38.0');
      const installed = path.join(work, '.terraform', 'providers', 'registry.terraform.io', 'hashicorp', 'kubernetes', '2.38.0', platform);
      expect((await lstat(installed)).isSymbolicLink()).toBe(true);
      expect(await readlink(installed)).toBe(place);

      await writeFile(path.join(work, 'main.tf.json'), JSON.stringify({ terraform: { required_providers: { kubernetes: { source: 'hashicorp/kubernetes', version: '2.37.0' } } } }));
      await expect(run(TERRAFORM, ['init', '-input=false', '-no-color', '-upgrade'], { cwd: work, env })).rejects.toThrow(/2\.37\.0/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
