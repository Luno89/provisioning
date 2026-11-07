import { describe, it, expect } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import { AppService } from './AppService.js';

const at = 'then';

describe('listing apps', () => {
  it('lists the person\'s own apps from Mongo as recorded, deleting none, whatever their cluster', async () => {
    const db = await testDatabase();
    const apps = new AppService(db, {} as never, {} as never, {} as never);
    await db.infrastructure.saveDeploymentInfo({ id: 'wp', name: 'WordPress', clusterId: 'c1', strategy: 'helm', appType: 'wordpress', ownerId: 'bo', status: 'running', createdAt: at });
    await db.infrastructure.saveDeploymentInfo({ id: 'books', name: 'Books', clusterId: 'c1', strategy: 'native', appType: 'audiobookshelf', ownerId: 'bo', status: 'failed', createdAt: at });
    await db.infrastructure.saveDeploymentInfo({ id: 'orphan', name: 'Orphan', clusterId: 'never-was', strategy: 'helm', appType: 'wordpress', ownerId: 'bo', status: 'running', createdAt: at });
    await db.infrastructure.saveDeploymentInfo({ id: 'theirs', name: 'Theirs', clusterId: 'c1', strategy: 'helm', appType: 'wordpress', ownerId: 'someone-else', status: 'running', createdAt: at });

    expect((await apps.getAll('bo')).map((app) => [app.id, app.status]).sort()).toEqual([['books', 'failed'], ['orphan', 'running'], ['wp', 'running']]);
    expect((await db.infrastructure.getDeployments()).map((app) => app.id).sort()).toEqual(['books', 'orphan', 'theirs', 'wp']);
  });
});
