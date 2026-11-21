import { describe, expect, it } from 'vitest';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { runOnce } from '../../platform/lib/migrations.js';
import { MEMORY_INDEX_APPS_MIGRATION, removeMemoryIndexApps } from './memory-index-apps.js';

describe('the memory index\'s old catalogue entries', () => {
  it('go once, by name: Qdrant, Quickwit and TEI as apps and their binding types, leaving every other entry and everything a person deployed', async () => {
    const db = memoryDatabase();
    for (const id of ['qdrant', 'quickwit', 'tei', 'odoo']) await db.infrastructure.saveAppSpec({ id, label: id, builtIn: true, createdAt: 'then', updatedAt: 'then' });
    for (const id of ['qdrant', 'quickwit', 'embeddings', 'postgres']) await db.infrastructure.saveBindingType({ id, label: id });
    await db.infrastructure.saveDeploymentInfo({ id: 'd1', appType: 'qdrant', ownerId: 'u1' } as never);

    expect(await runOnce(db.platform, MEMORY_INDEX_APPS_MIGRATION, 'now', () => removeMemoryIndexApps(db.infrastructure))).toEqual({ appSpecs: 3, bindingTypes: 3 });

    expect((await db.infrastructure.getAppSpecs()).map((spec) => spec.id)).toEqual(['odoo']);
    expect((await db.infrastructure.getBindingTypes()).map((type) => type.id)).toEqual(['postgres']);
    expect((await db.infrastructure.getDeployments()).map((deployment) => deployment.id)).toEqual(['d1']);

    await db.infrastructure.saveAppSpec({ id: 'qdrant', label: 'a person\'s own, later', builtIn: false, createdAt: 'later', updatedAt: 'later' });
    expect(await runOnce(db.platform, MEMORY_INDEX_APPS_MIGRATION, 'later', () => removeMemoryIndexApps(db.infrastructure))).toEqual({});
    expect((await db.infrastructure.getAppSpecs()).map((spec) => spec.id).sort()).toEqual(['odoo', 'qdrant']);
  });
});
