import { describe, expect, it } from 'vitest';
import { destroyAppArgs } from './app-destroy.js';
import { AppStackUnknown } from './deployment-id.js';

const reach = { clusterId: 'machine-desk', reach: { clusterId: 'machine-desk', kind: 'koala' as const } };

describe('what destroying an app is handed', () => {
  it('names the stack the app was deployed as, on its cluster', () => {
    const args = destroyAppArgs({ name: 'shop', clusterId: 'machine-desk', strategy: 'native', deploymentId: 'd1', appType: 'wordpress', namespace: 'shop-1a2b3c' }, { name: 'desk' }, '/log', reach);
    expect(args).toMatchObject({ deploymentId: 'd1', clusterName: 'desk', namespace: 'shop-1a2b3c' });
  });

  it('is refused for an app recorded without its stack id, never destroying a stack called default', () => {
    expect(() => destroyAppArgs({ name: 'shop', clusterId: 'machine-desk', strategy: 'native' }, { name: 'desk' }, '/log', reach)).toThrow(AppStackUnknown);
  });
});
