import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { Database } from '../../platform/index.js';
import { fakeSpawn, type SpawnRig } from '../testing/fake-spawn.js';
import { MoveExport, MOVING_FILE, VOLUME_HELPER } from './MoveExport.js';
import { REPLICAS_ANNOTATION } from '../lib/app-move.js';
import { generateIdentityKey, identityKeysFrom, issueMoveToken, publicKeyPem, trustedKeys } from '../lib/identity-token.js';

const containing = (text: string): unknown => expect.stringContaining(text);

const KEYS = { SESSION_KEY: 'a'.repeat(64), DATA_KEY: 'b'.repeat(64), PAYLOAD_KEY: 'c'.repeat(64), EGRESS_KEY: 'd'.repeat(64) };
const root = identityKeysFrom(generateIdentityKey());

let db: Database;
let dataDir: string;
let running: string[] | 'unknown';
let refusing: string[];
let rig: SpawnRig;
let move: MoveExport;

const kubectlSays = (asked: string): string | undefined => {
  if (asked === 'get namespaces -o json') return JSON.stringify({ items: [{ metadata: { name: 'books' } }, { metadata: { name: 'nowrinkles' } }] });
  if (asked === 'get deployments -n books -o json') return JSON.stringify({ items: [{ metadata: { name: 'web', annotations: { [REPLICAS_ANNOTATION]: '2' } } }, { metadata: { name: 'never-scaled' } }] });
  if (asked === 'get statefulsets -n books -o json') return JSON.stringify({ items: [] });
  if (asked.startsWith('get serviceaccounts,configmaps')) return JSON.stringify({ items: [{ kind: 'ConfigMap', metadata: { name: 'web-config' } }, { kind: 'ConfigMap', metadata: { name: 'kube-root-ca.crt' } }] });
  if (asked === 'get namespace books -o json') return JSON.stringify({ metadata: { name: 'books', labels: { team: 'a' } } });
  if (asked === 'get pods -n books -o json') return JSON.stringify({ items: [] });
  return undefined;
};

const makeMove = (env: NodeJS.ProcessEnv = KEYS): MoveExport => new MoveExport({
  instanceId: 'inst-bo',
  trusted: trustedKeys([publicKeyPem(root.publicKey)]),
  dataDir,
  mongo: { uri: 'mongodb://unused', dbName: 'provisioning' },
  env,
  running: async () => running,
  spawn: rig.spawn,
  claim: (jti, expiresAt) => db.instances.claimHandoff(jti, expiresAt),
});

beforeEach(async () => {
  db = memoryDatabase();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'move-'));
  running = [];
  refusing = [];
  rig = fakeSpawn((argv) => {
    const asked = argv.slice(1).join(' ');
    if (argv[0] === 'kubectl' && refusing.some((prefix) => asked.startsWith(prefix))) return { stderr: 'Error from server (Forbidden): not allowed', code: 1 };
    return argv[0] === 'kubectl' ? { stdout: kubectlSays(asked) ?? 'kubectl output' } : undefined;
  });
  move = makeMove();
  await move.load();
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const kubectlRan = () => rig.ran.filter(([command]) => command === 'kubectl').map((argv) => argv.slice(1).join(' '));
const read = async (stream: NodeJS.ReadableStream): Promise<string> => {
  let text = '';
  for await (const chunk of stream) text += String(chunk);
  return text;
};

describe('a pool instance deciding whether root may have a part of it', () => {
  it('takes the token for the part asked and no other, and none from a stranger', async () => {
    expect(await move.check(issueMoveToken(root, 'inst-bo', 'keys'), 'keys')).toBeUndefined();
    expect(await move.check(issueMoveToken(root, 'inst-bo', 'data'), 'keys')).toMatchObject({ status: 401, error: containing('root did not ask for this') });
    expect(await move.check(issueMoveToken(identityKeysFrom(generateIdentityKey()), 'inst-bo', 'keys'), 'keys')).toMatchObject({ status: 401 });
    expect(await move.check(undefined, 'keys')).toMatchObject({ status: 401 });
  });

  it('takes each token once', async () => {
    const token = issueMoveToken(root, 'inst-bo', 'keys');
    expect(await move.check(token, 'keys')).toBeUndefined();
    expect(await move.check(token, 'keys')).toEqual({ status: 409, error: 'root\'s request for this was already answered; ask again' });
  });

  it('judges a token by the clock it is given', async () => {
    const later = new MoveExport({
      instanceId: 'inst-bo', trusted: trustedKeys([publicKeyPem(root.publicKey)]), dataDir, mongo: { uri: 'x', dbName: 'y' }, env: KEYS,
      running: async () => [], spawn: rig.spawn, claim: (jti, expiresAt) => db.instances.claimHandoff(jti, expiresAt), now: () => Date.now() + 24 * 3600 * 1000,
    });
    expect(await later.check(issueMoveToken(root, 'inst-bo', 'keys'), 'keys')).toMatchObject({ status: 401 });
  });
});

describe('a pool instance stopping for a move', () => {
  it('stops taking work when it begins, writing the mark and pausing its self-upgrade', async () => {
    expect(move.isFrozen()).toBe(false);
    expect(await move.freeze()).toBeUndefined();
    expect(move.isFrozen()).toBe(true);
    expect(fs.existsSync(path.join(dataDir, MOVING_FILE))).toBe(true);
    expect(kubectlRan()).toEqual(['patch cronjob instance-self-upgrade -n nowrinkles --type=merge -p {"spec":{"suspend":true}}']);
    expect(await move.freeze()).toBeUndefined();
    expect(kubectlRan()).toHaveLength(1);
  });

  it('remembers across a restart that it was stopped', async () => {
    await move.freeze();
    const restarted = makeMove();
    await restarted.load();
    expect(restarted.isFrozen()).toBe(true);
  });

  it('refuses to start while work runs, saying what', async () => {
    running = ['Koala chat: plan the shop', 'a release'];
    expect(await move.freeze()).toEqual({ status: 409, error: 'finish or stop what runs first, then start the move again: Koala chat: plan the shop; a release' });
    expect(fs.existsSync(path.join(dataDir, MOVING_FILE))).toBe(false);
  });

  it('says it is still starting, without stopping work, while it cannot yet tell what runs', async () => {
    running = 'unknown';
    expect(await move.freeze()).toMatchObject({ status: 503 });
    expect(move.isFrozen()).toBe(false);
  });

  it('does not stop for the move when it cannot pause its own self-upgrade', async () => {
    refusing = ['patch cronjob instance-self-upgrade'];
    const refused = await move.freeze();
    expect(refused).toMatchObject({ status: 500 });
    expect(refused?.error).toContain('its self-upgrade could not be paused, so it was not stopped for the move');
    expect(fs.existsSync(path.join(dataDir, MOVING_FILE))).toBe(false);
  });

  it('fails to load when the mark cannot be looked for', async () => {
    const broken = new MoveExport({ ...{ instanceId: 'inst-bo', trusted: trustedKeys([]), mongo: { uri: 'x', dbName: 'y' }, env: KEYS, running: async () => [], claim: async () => true }, dataDir: path.join(dataDir, MOVING_FILE, 'inside') });
    await fs.promises.writeFile(path.join(dataDir, MOVING_FILE), 'x');
    await expect(broken.load()).rejects.toThrow();
  });
});

describe('a pool instance taking work again', () => {
  it('starts its apps as they were and its self-upgrade, and removes the mark', async () => {
    await move.freeze();
    expect(await move.thaw()).toEqual([]);
    expect(kubectlRan()).toEqual(expect.arrayContaining([
      'scale deployments web -n books --replicas=2',
      `annotate deployments web -n books ${REPLICAS_ANNOTATION}-`,
      'delete pod koala-move-volume -n books --ignore-not-found',
      'patch cronjob instance-self-upgrade -n nowrinkles --type=merge -p {"spec":{"suspend":false}}',
    ]));
    expect(kubectlRan().some((ran) => ran.includes('never-scaled'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, MOVING_FILE))).toBe(false);
    expect(move.isFrozen()).toBe(false);
  });

  it('says which apps it could not start again, still taking work itself', async () => {
    await move.freeze();
    refusing = ['scale deployments web'];
    expect(await move.thaw()).toEqual(['books\'s apps could not be started again: kubectl ended with 1: Error from server (Forbidden): not allowed']);
    expect(fs.existsSync(path.join(dataDir, MOVING_FILE))).toBe(false);
    expect(move.isFrozen()).toBe(false);
  });

  it('says so when it cannot list its apps\' namespaces or switch its self-upgrade back on', async () => {
    await move.freeze();
    refusing = ['get namespaces', 'patch cronjob'];
    const problems = await move.thaw();
    expect(problems).toEqual([
      'its apps\' namespaces could not be listed: kubectl ended with 1: Error from server (Forbidden): not allowed',
      'its self-upgrade could not be switched back on: kubectl ended with 1: Error from server (Forbidden): not allowed',
    ]);
    expect(move.isFrozen()).toBe(false);
  });

  it('reports a program that cannot be started at all', async () => {
    const missing = new MoveExport({
      instanceId: 'inst-bo', trusted: trustedKeys([]), dataDir, mongo: { uri: 'x', dbName: 'y' }, env: KEYS, running: async () => [], claim: async () => true,
      spawn: (() => {
        const failing = Object.assign(new EventEmitter(), { stderr: new PassThrough(), stdout: new PassThrough() });
        setImmediate(() => failing.emit('error', new Error('spawn kubectl ENOENT')));
        return failing;
      }) as never,
    });
    expect(await missing.thaw()).toEqual(expect.arrayContaining([expect.stringContaining('spawn kubectl ENOENT')]));
  });
});

describe('the parts of a pool instance root may take', () => {
  it('hands over the four keys and nothing else of its environment', async () => {
    const opened = move.open('keys');
    expect(opened.type).toBe('text/plain');
    expect(await read(opened.out)).toBe(`SESSION_KEY=${KEYS.SESSION_KEY}\nDATA_KEY=${KEYS.DATA_KEY}\nPAYLOAD_KEY=${KEYS.PAYLOAD_KEY}\nEGRESS_KEY=${KEYS.EGRESS_KEY}\n`);
    await opened.done;
  });

  it('refuses to hand over keys it does not have', () => {
    const lacking = makeMove({ ...KEYS, DATA_KEY: '' });
    expect(() => lacking.open('keys')).toThrow('this instance has no DATA_KEY');
  });

  it('archives its data folder without the mark and its logs', async () => {
    fs.writeFileSync(path.join(dataDir, '.gitea-admin-password'), 'secret');
    fs.mkdirSync(path.join(dataDir, 'caddy'));
    fs.mkdirSync(path.join(dataDir, 'logs'));
    fs.writeFileSync(path.join(dataDir, MOVING_FILE), 'x');
    const opened = move.open('data');
    expect(await read(opened.out)).toBe('tar output');
    await opened.done;
    expect(opened.type).toBe('application/gzip');
    expect(rig.ran.at(-1)).toEqual(['tar', 'czf', '-', '-C', dataDir, '--', '.gitea-admin-password', 'caddy']);
  });

  it('dumps each database from its own pod and archives Gitea\'s files', async () => {
    const gitea = move.open('gitea-db');
    await read(gitea.out);
    expect(gitea.type).toBe('application/octet-stream');
    expect(rig.ran.at(-1)?.slice(0, 7)).toEqual(['kubectl', 'exec', '-n', 'gitea', 'gitea-postgresql-0', '--', 'sh']);
    const infisical = move.open('infisical-db');
    await read(infisical.out);
    expect(rig.ran.at(-1)?.slice(0, 6)).toEqual(['kubectl', 'exec', '-n', 'infisical', 'postgresql-0', '--']);
    const files = move.open('gitea-data');
    await read(files.out);
    expect(files.type).toBe('application/gzip');
    expect(rig.ran.at(-1)?.slice(0, 7)).toEqual(['kubectl', 'exec', '-n', 'gitea', 'deploy/gitea', '-c', 'gitea']);
  });

  it('fails the part when the program that reads it fails', async () => {
    refusing = ['exec -n gitea'];
    const opened = move.open('gitea-data');
    await expect(opened.done).rejects.toThrow('kubectl ended with 1: Error from server (Forbidden): not allowed');
  });

  it('lists its apps with their volumes, after scaling them to nothing', async () => {
    const opened = move.open('apps');
    expect(opened.type).toBe('application/json');
    expect(JSON.parse(await read(opened.out))).toMatchObject({ pullHost: '', namespaces: [{ namespace: 'books', labels: { team: 'a' }, objects: [{ metadata: { name: 'web-config' } }] }] });
    await opened.done;
    expect(kubectlRan()).toEqual(expect.arrayContaining([
      `annotate deployments never-scaled -n books ${REPLICAS_ANNOTATION}=1`,
      'scale deployments never-scaled -n books --replicas=0',
      'scale deployments web -n books --replicas=0',
    ]));
    expect(kubectlRan().some((ran) => ran.startsWith(`annotate deployments web`))).toBe(false);
  });

  it('copies a volume out of its namespace through a helper pod it removes afterwards', async () => {
    const volume = move.volume('books', 'data-web-0');
    expect(volume.type).toBe('application/gzip');
    expect(await read(volume.out)).toBe('kubectl output');
    await volume.done;
    const ran = kubectlRan();
    expect(ran[0]).toBe(`delete pod ${VOLUME_HELPER} -n books --ignore-not-found --wait=true`);
    expect(ran[1]).toContain(`run ${VOLUME_HELPER} -n books --image=busybox:1.37 --restart=Never --overrides=`);
    expect(ran[1]).toContain('data-web-0');
    expect(ran).toEqual(expect.arrayContaining([`wait pod/${VOLUME_HELPER} -n books --for=condition=Ready --timeout=720h`, `exec -n books ${VOLUME_HELPER} -- tar czf - -C /volume .`]));
    expect(ran.at(-1)).toBe(`delete pod ${VOLUME_HELPER} -n books --ignore-not-found --wait=false`);
  });

  it('still removes the helper pod when reading the volume fails', async () => {
    refusing = ['exec -n books'];
    const volume = move.volume('books', 'data-web-0');
    volume.out.on('error', () => undefined);
    await expect(volume.done).rejects.toThrow('kubectl ended with 1');
    expect(kubectlRan().at(-1)).toBe(`delete pod ${VOLUME_HELPER} -n books --ignore-not-found --wait=false`);
  });
});
