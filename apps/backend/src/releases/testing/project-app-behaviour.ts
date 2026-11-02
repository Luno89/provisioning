import { describe, expect, it } from 'vitest';
import { ProjectAppService } from '../services/ProjectAppService.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { DeploymentMetadata } from '../../platform/lib/types.js';

const project = { id: 'p1', name: 'Shop', ownerId: 'bo' };
const app = (over: Partial<DeploymentMetadata> = {}): DeploymentMetadata => ({ id: 'odoo-p1', name: 'Shop', clusterId: 'c', strategy: 'helm', appType: 'odoo-project', ownerId: 'bo', gitappProjectId: 'p1', status: 'running', ...over });

async function service(db: Database, deployments: DeploymentMetadata[]) {
  for (const deployment of deployments) await db.infrastructure.saveDeployment(deployment);
  const exposed: string[] = [];
  const svc = new ProjectAppService({
    deployments: () => db.infrastructure.getDeployments(),
    expose: async (id, mode) => {
      exposed.push(`${id} ${mode}`);
      const found = (await db.infrastructure.getDeployments()).find((entry) => entry.id === id)!;
      await db.infrastructure.saveDeployment(mode === 'local'
        ? { ...found, localExposureUrl: 'http://shop-1a2b3c.localhost:8000', previewLocalUrl: 'http://shop-1a2b3c-preview.localhost:8000' }
        : { ...found, publicExposureUrl: 'https://shop-x.example.com', previewPublicUrl: 'https://shop-preview-x.example.com' });
    },
  });
  return { svc, exposed };
}

export function projectAppBehaviour(make: () => Promise<Database>): void {
  describe('opening a project\'s app', () => {
    it('exposes it on this machine the first time and gives back its and its preview\'s addresses', async () => {
      const { svc, exposed } = await service(await make(), [app()]);
      expect(await svc.open(project, 'local')).toMatchObject({ local: { app: 'http://shop-1a2b3c.localhost:8000', preview: 'http://shop-1a2b3c-preview.localhost:8000' }, public: {} });
      expect(await svc.open(project, 'local')).toMatchObject({ local: { app: 'http://shop-1a2b3c.localhost:8000' } });
      expect(exposed).toEqual(['odoo-p1 local']);
    });

    it('exposes it publicly only when asked to', async () => {
      const { svc, exposed } = await service(await make(), [app({ localExposureUrl: 'http://shop.localhost:8000' })]);
      expect(await svc.open(project, 'public')).toMatchObject({ public: { app: 'https://shop-x.example.com', preview: 'https://shop-preview-x.example.com' } });
      expect(exposed).toEqual(['odoo-p1 public']);
    });

    it('refuses while there is no app, or it is not running, and says why', async () => {
      expect(await (await service(await make(), [])).svc.open(project, 'local')).toEqual({ status: 409, error: 'the project has no app yet: it is made by the first build that deploys' });
      expect(await (await service(await make(), [app({ status: 'deploying' })])).svc.open(project, 'local')).toEqual({ status: 409, error: 'the app is deploying, not running, so there is nothing to open yet' });
    });

    it('never opens someone else\'s app built from a project of the same id', async () => {
      expect(await (await service(await make(), [app({ ownerId: 'cy' })])).svc.app(project)).toBeUndefined();
    });
  });
}
