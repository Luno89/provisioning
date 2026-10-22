import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { moveRouter } from './move.js';
import { MoveExport, MOVING_FILE } from '../services/MoveExport.js';
import { generateIdentityKey, identityKeysFrom, issueMoveToken, publicKeyPem, trustedKeys } from '../lib/identity-token.js';

const KEYS = { SESSION_KEY: 'a'.repeat(64), DATA_KEY: 'b'.repeat(64), PAYLOAD_KEY: 'c'.repeat(64), EGRESS_KEY: 'd'.repeat(64) };
const root = identityKeysFrom(generateIdentityKey());

let harness: Harness;
let dataDir: string;
let running: string[] | 'unknown';
let spawned: string[][];

const fakeSpawn = ((command: string, args: string[]) => {
  spawned.push([command, ...args]);
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  setImmediate(() => { child.stdout.end(`${command} output`); child.emit('close', 0); });
  return child;
}) as never;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'move-'));
  running = [];
  spawned = [];
  const move = new MoveExport({
    instanceId: 'inst-bo', trusted: trustedKeys([publicKeyPem(root.publicKey)]), dataDir,
    mongo: { uri: 'mongodb://unused', dbName: 'provisioning' }, env: KEYS, running: async () => running, spawn: fakeSpawn,
  });
  await move.load();
  harness = await mountRouter({ prefix: '/api/move', user: TEST_USER, router: () => moveRouter({ move }) });
});

afterEach(async () => {
  await harness.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const get = (part: string, token: string) => axios.get(harness.url(`/api/move/parts/${part}?token=${encodeURIComponent(token)}`), { validateStatus: () => true, responseType: 'text' });

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

    const data = await get('data', issueMoveToken(root, 'inst-bo', 'data'));
    expect(data.data).toBe('tar output');
    expect(spawned.at(-1)).toEqual(['tar', 'czf', '-', '-C', dataDir, '--', '.gitea-admin-password', 'caddy']);
    const gitea = await get('gitea-data', issueMoveToken(root, 'inst-bo', 'gitea-data'));
    expect(gitea.data).toBe('kubectl output');
    expect(spawned.at(-1)?.slice(0, 7)).toEqual(['kubectl', 'exec', '-n', 'gitea', 'deploy/gitea', '-c', 'gitea']);
  });

  it('refuses to start while work runs, saying what', async () => {
    running = ['Koala chat: plan the shop'];
    const refused = await get('keys', issueMoveToken(root, 'inst-bo', 'keys'));
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.data).error).toContain('Koala chat: plan the shop');
    expect(fs.existsSync(path.join(dataDir, MOVING_FILE))).toBe(false);
  });

  it('says it is still starting, without stopping work, while it cannot yet tell what runs', async () => {
    running = 'unknown';
    const starting = await get('keys', issueMoveToken(root, 'inst-bo', 'keys'));
    expect(starting.status).toBe(503);
    expect(fs.existsSync(path.join(dataDir, MOVING_FILE))).toBe(false);
  });

  it('takes work again when root says the move stopped', async () => {
    await get('keys', issueMoveToken(root, 'inst-bo', 'keys'));
    const thawed = await axios.post(harness.url(`/api/move/thaw?token=${encodeURIComponent(issueMoveToken(root, 'inst-bo', 'thaw'))}`), {}, { validateStatus: () => true });
    expect(thawed.data).toEqual({ thawed: true });
    expect(fs.existsSync(path.join(dataDir, MOVING_FILE))).toBe(false);
  });
});
