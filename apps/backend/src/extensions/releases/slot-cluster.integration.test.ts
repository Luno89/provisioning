import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { giteaStandIn, type GiteaStandIn } from '../../projects/testing/gitea-api.js';
import { createSlotCluster } from './slot-cluster.js';

const COMMIT = 'c'.repeat(40);
const FILES: Record<string, string> = {
  'deploy/chart/Chart.yaml': 'apiVersion: v2\nname: shop\nversion: 0.1.0\n',
  'deploy/chart/templates/odoo.yaml': 'kind: Deployment\n',
  'addons/shop/__manifest__.py': "{'name': 'Shop'}\n",
};
let gitea: GiteaStandIn;

beforeAll(async () => { gitea = await giteaStandIn({ owner: 'bo', name: 'shop', commit: COMMIT, files: FILES }); });
afterAll(async () => { await gitea.close(); });

describe('a release slot reading its build\'s files through Gitea', () => {
  it('lists and reads the build\'s files, and installs the chart it holds with what Gitea served', async () => {
    const charted: Record<string, string> = {};
    const infra = {
      applyManifest: async () => '',
      runHelmWithChart: async (args: (at: string) => string[], chart: string) => {
        for (const file of ['Chart.yaml', 'templates/odoo.yaml']) charted[file] = readFileSync(path.join(chart, file), 'utf8');
        return args(chart).join(' ');
      },
    };
    const cluster = createSlotCluster({ infra: infra as never, repo: async () => gitea.gitea(), registry: async () => ({ hosts: { push: 'r', pull: 'r' }, username: 'u', password: 'p' }), syncVault: async () => undefined });
    const source = { owner: 'bo', repo: 'shop', commit: COMMIT };
    expect(await cluster.files(source)).toEqual(Object.keys(FILES));
    expect(await cluster.file(source, 'addons/shop/__manifest__.py')).toBe("{'name': 'Shop'}\n");
    expect(await cluster.file(source, 'missing.txt')).toBeNull();
    await cluster.apply({ clusterName: 'own', provider: 'hetzner', kubeconfigPath: '/kube/own', namespace: 'shop-1', release: 'shop-1' } as never, source, ['--set', 'live=a']);
    expect(charted).toEqual({ 'Chart.yaml': FILES['deploy/chart/Chart.yaml'], 'templates/odoo.yaml': FILES['deploy/chart/templates/odoo.yaml'] });
    expect(gitea.asked.every((line) => line.endsWith('token bot-token'))).toBe(true);
  });
});
