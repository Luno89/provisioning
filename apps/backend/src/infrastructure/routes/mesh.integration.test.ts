import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { mock } from 'vitest-mock-extended';
import type { HeadscaleService, MeshDevice } from '../services/HeadscaleService.js';
import { meshRouter } from './mesh.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const device = (id: string): MeshDevice => ({ id, name: `node-${id}`, ipAddresses: ['100.64.0.2'], online: true });
const quiet = { validateStatus: () => true };

describe('/api/mesh over HTTP', () => {
  it('lists, makes keys and revokes as the signed-in person, and never touches a machine that is not theirs', async () => {
    const headscaleService = mock<HeadscaleService>();
    headscaleService.listUserDevices.calledWith(TEST_USER.id).mockResolvedValue([device('1')]);
    headscaleService.createPreAuthKey.mockResolvedValue({ key: 'k1' } as never);
    harness = await mountRouter({ prefix: '/api/mesh', router: () => meshRouter({ headscaleService }) });

    expect((await axios.get(harness.url('/api/mesh/devices'))).data).toEqual([device('1')]);
    const made = await axios.post(harness.url('/api/mesh/preauth-key'), { reusable: true, expirySeconds: 600 });
    expect([made.status, made.data]).toEqual([201, { key: 'k1' }]);
    expect(headscaleService.createPreAuthKey).toHaveBeenCalledWith(TEST_USER.id, { reusable: true, expirySeconds: 600 });
    expect((await axios.delete(harness.url('/api/mesh/devices/2'), quiet)).status).toBe(404);
    expect(headscaleService.revokeDevice).not.toHaveBeenCalled();
    expect((await axios.delete(harness.url('/api/mesh/devices/1'))).data).toEqual({ success: true });
    expect(headscaleService.revokeDevice).toHaveBeenCalledWith('1');
  });

  it('says the mesh is unavailable when it cannot be read', async () => {
    const headscaleService = mock<HeadscaleService>();
    headscaleService.listUserDevices.mockRejectedValue(new Error('headscale is down'));
    harness = await mountRouter({ prefix: '/api/mesh', router: () => meshRouter({ headscaleService }) });
    const down = await axios.get(harness.url('/api/mesh/devices'), quiet);
    expect([down.status, down.data]).toEqual([503, { error: 'Mesh unavailable: headscale is down' }]);
  });
});
