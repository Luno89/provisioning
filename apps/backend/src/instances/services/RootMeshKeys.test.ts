import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { RootMeshKeys } from './RootMeshKeys.js';

const seen: { instance: string | undefined; auth: string | undefined }[] = [];
const app = express();
app.post('/api/instances/machine-key', (req, res) => {
  seen.push({ instance: req.header('x-instance-id'), auth: req.header('authorization') });
  if (req.header('authorization') !== 'Bearer right') return res.status(401).json({ error: 'unknown instance or credential' });
  res.json({ preAuthKey: 'key-1', meshLoginServer: 'https://mesh.example.com' });
});
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const rootUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('an instance asking root for a machine\'s mesh key', () => {
  it('asks as itself and hands back the key', async () => {
    expect(await new RootMeshKeys({ rootUrl, instanceId: 'inst-1', credential: 'right' }).createPreAuthKey('owner')).toEqual({ key: 'key-1' });
    expect(seen.at(-1)).toEqual({ instance: 'inst-1', auth: 'Bearer right' });
  });

  it('says why when root refuses', async () => {
    await expect(new RootMeshKeys({ rootUrl, instanceId: 'inst-1', credential: 'wrong' }).createPreAuthKey('owner'))
      .rejects.toThrow('root would not let a machine join the mesh (401): unknown instance or credential');
  });
});
