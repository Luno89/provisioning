import { afterEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { HeadscaleService, MeshDevice } from '../services/HeadscaleService.js';
import { meshRouter } from './mesh.js';
import { callRouter, PERSON } from '../testing/call-router.js';

const device = (id: string): MeshDevice => ({ id, name: `node-${id}`, ipAddresses: ['100.64.0.2'], online: true });
const original = process.env.MESH_LOGIN_SERVER;

afterEach(() => {
  if (original === undefined) delete process.env.MESH_LOGIN_SERVER;
  else process.env.MESH_LOGIN_SERVER = original;
});

describe('/api/mesh', () => {
  it('says the mesh is configured only when its login server is not this machine', async () => {
    const router = meshRouter({ headscaleService: mock<HeadscaleService>() });
    process.env.MESH_LOGIN_SERVER = 'https://mesh.example.com';
    expect((await callRouter(router, '/api/mesh', { path: '/config' })).body).toEqual({ loginServer: 'https://mesh.example.com', configured: true });
    process.env.MESH_LOGIN_SERVER = 'http://localhost:8080';
    expect((await callRouter(router, '/api/mesh', { path: '/config' })).body).toEqual({ loginServer: 'http://localhost:8080', configured: false });
    delete process.env.MESH_LOGIN_SERVER;
    expect((await callRouter(router, '/api/mesh', { path: '/config' })).body).toEqual({ loginServer: null, configured: false });
  });

  it('lists the machines the person has on the mesh, and says the mesh is unavailable when it cannot be read', async () => {
    const headscaleService = mock<HeadscaleService>();
    headscaleService.listUserDevices.calledWith(PERSON.id).mockResolvedValue([device('1')]);
    expect((await callRouter(meshRouter({ headscaleService }), '/api/mesh', { path: '/devices' })).body).toEqual([device('1')]);
    headscaleService.listUserDevices.mockRejectedValue(new Error('headscale is down'));
    const down = await callRouter(meshRouter({ headscaleService }), '/api/mesh', { path: '/devices' });
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ error: 'Mesh unavailable: headscale is down' });
  });

  it('makes a key for the person, reusable only when asked, with the expiry given', async () => {
    const headscaleService = mock<HeadscaleService>();
    headscaleService.createPreAuthKey.mockResolvedValue({ key: 'k1' } as never);
    const answer = await callRouter(meshRouter({ headscaleService }), '/api/mesh', { method: 'POST', path: '/preauth-key', body: { reusable: true, expirySeconds: 600 } });
    expect(answer.status).toBe(201);
    expect(headscaleService.createPreAuthKey).toHaveBeenCalledWith(PERSON.id, { reusable: true, expirySeconds: 600 });
    await callRouter(meshRouter({ headscaleService }), '/api/mesh', { method: 'POST', path: '/preauth-key', body: {} });
    expect(headscaleService.createPreAuthKey).toHaveBeenLastCalledWith(PERSON.id, { reusable: false });
  });

  it('says the mesh is unavailable when a key cannot be made', async () => {
    const headscaleService = mock<HeadscaleService>();
    headscaleService.createPreAuthKey.mockRejectedValue(new Error('no user'));
    const answer = await callRouter(meshRouter({ headscaleService }), '/api/mesh', { method: 'POST', path: '/preauth-key', body: {} });
    expect(answer.status).toBe(503);
  });

  it('revokes only a machine the person owns', async () => {
    const headscaleService = mock<HeadscaleService>();
    headscaleService.listUserDevices.mockResolvedValue([device('1')]);
    const router = meshRouter({ headscaleService });
    expect((await callRouter(router, '/api/mesh', { method: 'DELETE', path: '/devices/2' })).status).toBe(404);
    expect(headscaleService.revokeDevice).not.toHaveBeenCalled();
    expect((await callRouter(router, '/api/mesh', { method: 'DELETE', path: '/devices/1' })).body).toEqual({ success: true });
    expect(headscaleService.revokeDevice).toHaveBeenCalledWith('1');
  });

  it('says the mesh is unavailable when a revoke fails', async () => {
    const headscaleService = mock<HeadscaleService>();
    headscaleService.listUserDevices.mockResolvedValue([device('1')]);
    headscaleService.revokeDevice.mockRejectedValue(new Error('refused'));
    expect((await callRouter(meshRouter({ headscaleService }), '/api/mesh', { method: 'DELETE', path: '/devices/1' })).status).toBe(503);
  });
});
