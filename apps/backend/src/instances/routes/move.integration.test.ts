import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn, type SpawnOptions } from 'child_process';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { moveRouter } from './move.js';
import { MoveExport, MOVING_FILE, type MoveCluster } from '../services/MoveExport.js';
import { REPLICAS_ANNOTATION } from '../lib/app-move.js';
import { generateIdentityKey, identityKeysFrom, issueMoveToken, publicKeyPem, trustedKeys } from '../lib/identity-token.js';

const containing = (text: string): unknown => expect.stringContaining(text);
const including = (items: unknown[]): unknown => expect.arrayContaining(items);

const KEYS = { SESSION_KEY: 'a'.repeat(64), DATA_KEY: 'b'.repeat(64), PAYLOAD_KEY: 'c'.repeat(64), EGRESS_KEY: 'd'.repeat(64) };
const root = identityKeysFrom(generateIdentityKey());

let harness: Harness;
let dataDir: string;
let stubDir: string;
let running: string[] | 'unknown';
let spawned: string[][];

const FORBIDDEN = 'Error from server (Forbidden): not allowed';
let refusing: string[];
let asked: string[];

const kubectlSays = (line: string): string => {
  if (line === 'get namespaces -o json') return JSON.stringify({ items: [{ metadata: { name: 'books' } }, { metadata: { name: 'nowrinkles' } }] });
  if (line === 'get deployments -n books -o json') return JSON.stringify({ items: [{ metadata: { name: 'web', annotations: { [REPLICAS_ANNOTATION]: '2' } } }, { metadata: { name: 'never-scaled' } }] });
  if (line === 'get statefulsets -n books -o json') return JSON.stringify({ items: [] });
  return 'kubectl output';
};

const cluster: MoveCluster = {
  kubectl: async (args) => {
    const line = args.join(' ');
    asked.push(line);
    if (refusing.some((prefix) => line.startsWith(prefix))) throw new Error(FORBIDDEN);
    return kubectlSays(line);
  },
  read: async (args, into) => {
    const line = args.join(' ');
    asked.push(line);
    into.end(kubectlSays(line));
  },
};

const refuse = (prefixes: string[]): void => { refusing = prefixes; };

const recordingSpawn = ((command: string, args: string[], options: SpawnOptions) => {
  spawned.push([command, ...args]);
  return spawn(command, args, options);
}) as typeof spawn;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'move-'));
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'move-stub-'));
  refuse([]);
  asked = [];
  running = [];
  spawned = [];
  harness = await mountRouter({
    prefix: '/api/move', user: TEST_USER,
    router: async (db) => {
      const move = new MoveExport({
        instanceId: 'inst-bo', trusted: trustedKeys([publicKeyPem(root.publicKey)]), dataDir,
        mongo: { uri: 'mongodb://unused', dbName: 'provisioning' }, env: KEYS, running: async () => running, cluster, spawn: recordingSpawn,
        claim: (jti, expiresAt) => db.instances.claimHandoff(jti, expiresAt),
      });
      await move.load();
      return moveRouter({ move });
    },
  });
});

afterEach(async () => {
  await harness.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(stubDir, { recursive: true, force: true });
});

const get = (part: string, token: string) => axios.get<string>(harness.url(`/api/move/parts/${part}`), { headers: { 'x-koala-move-token': token }, validateStatus: () => true, responseType: 'text' });

describe('a pool instance handing itself over', () => {
  it('hands each part only to root\'s token for that part, and stops taking work from the first', async () => {
    expect((await get('keys', issueMoveToken(root, 'inst-bo', 'data'))).status).toBe(401);
    expect((await get('keys', issueMoveToken(identityKeysFrom(generateIdentityKey()), 'inst-bo', 'keys'))).status).toBe(401);
    expect(fs.existsSync(path.join(dataDir, MOVING_FILE))).toBe(false);

    fs.writeFileSync(path.join(dataDir, '.gitea-admin-password'), 'secret');
    fs.mkdirSync(path.join(dataDir, 'caddy'));
    fs.mkdirSync(path.join(dataDir, 'logs'));
    const keys = await get('keys', issueMoveToken(root, 'inst-bo', 'keys'));
    expect(keys.status).toBe(200);
    expect(keys.data).toContain(`DATA_KEY=${KEYS.DATA_KEY}`);
    expect(fs.existsSync(path.join(dataDir, MOVING_FILE))).toBe(true);

    const data = await axios.get<ArrayBuffer>(harness.url('/api/move/parts/data'), { headers: { 'x-koala-move-token': issueMoveToken(root, 'inst-bo', 'data') }, responseType: 'arraybuffer' });
    const archive = path.join(stubDir, 'data.tgz');
    fs.writeFileSync(archive, Buffer.from(data.data));
    expect(execFileSync('tar', ['tzf', archive], { encoding: 'utf8' }).split('\n').filter(Boolean).sort()).toEqual(['.gitea-admin-password', 'caddy/']);
    expect(spawned.at(-1)).toEqual(['tar', 'czf', '-', '-C', dataDir, '--', '.gitea-admin-password', 'caddy']);
    const gitea = await get('gitea-data', issueMoveToken(root, 'inst-bo', 'gitea-data'));
    expect(gitea.data).toBe('kubectl output');
    expect(asked.at(-1)).toMatch(/^exec -n gitea deploy\/gitea -c gitea /);
  });

  it('takes each of root\'s tokens once, and never from the address', async () => {
    const token = issueMoveToken(root, 'inst-bo', 'keys');
    expect((await axios.get(harness.url(`/api/move/parts/keys?token=${encodeURIComponent(token)}`), { validateStatus: () => true })).status).toBe(401);
    expect((await get('keys', token)).status).toBe(200);
    const again = await get('keys', token);
    expect(again.status).toBe(409);
    expect(again.data).toMatch(/already answered/);
  });

  it('refuses to start while work runs, saying what', async () => {
    running = ['Koala chat: plan the shop'];
    const refused = await get('keys', issueMoveToken(root, 'inst-bo', 'keys'));
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.data)).toMatchObject({ error: containing('Koala chat: plan the shop') });
    expect(fs.existsSync(path.join(dataDir, MOVING_FILE))).toBe(false);
  });

  it('says it is still starting, without stopping work, while it cannot yet tell what runs', async () => {
    running = 'unknown';
    const starting = await get('keys', issueMoveToken(root, 'inst-bo', 'keys'));
    expect(starting.status).toBe(503);
    expect(fs.existsSync(path.join(dataDir, MOVING_FILE))).toBe(false);
  });

  const thaw = () => axios.post<{ error?: string }>(harness.url('/api/move/thaw'), {}, { headers: { 'x-koala-move-token': issueMoveToken(root, 'inst-bo', 'thaw') }, validateStatus: () => true });
  const kubectlRan = () => asked;

  it('takes work again when root says the move stopped, starting its apps as they were and its self-upgrade', async () => {
    await get('keys', issueMoveToken(root, 'inst-bo', 'keys'));
    expect(kubectlRan()).toContain('patch cronjob instance-self-upgrade -n nowrinkles --type=merge -p {"spec":{"suspend":true}}');
    const thawed = await thaw();
    expect(thawed.data).toEqual({ thawed: true });
    expect(kubectlRan()).toEqual(including([
      'scale deployments web -n books --replicas=2',
      `annotate deployments web -n books ${REPLICAS_ANNOTATION}-`,
      'patch cronjob instance-self-upgrade -n nowrinkles --type=merge -p {"spec":{"suspend":false}}',
    ]));
    expect(kubectlRan().some((ran) => ran.includes('never-scaled'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, MOVING_FILE))).toBe(false);
  });

  it('says which apps it could not start again, still taking work itself', async () => {
    await get('keys', issueMoveToken(root, 'inst-bo', 'keys'));
    refuse(['scale deployments web']);
    const thawed = await thaw();
    expect(thawed.status).toBe(500);
    expect(thawed.data.error).toBe(`it takes work again, but books's apps could not be started again: ${FORBIDDEN}`);
    expect(fs.existsSync(path.join(dataDir, MOVING_FILE))).toBe(false);
  });

  it('does not stop for the move when it cannot pause its own self-upgrade', async () => {
    refuse(['patch cronjob instance-self-upgrade']);
    const refused = await get('keys', issueMoveToken(root, 'inst-bo', 'keys'));
    expect(refused.status).toBe(500);
    expect(refused.data).toContain('its self-upgrade could not be paused, so it was not stopped for the move');
    expect(fs.existsSync(path.join(dataDir, MOVING_FILE))).toBe(false);
  });
});
