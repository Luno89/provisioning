import { describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import { arrayWith } from '../../platform/lib/test-matchers.js';
import { ENGINE_TOOL_SEEDS, seedEngineTools } from './engine-tool-seeds.js';

describe('seeding the platform\'s tools into Mongo', () => {
  it('stores every shipped tool and removes a built-in one Koala no longer ships, leaving a person\'s own alone', async () => {
    const db = await testDatabase();
    const shipped = ENGINE_TOOL_SEEDS[0]!;
    await db.engine.saveEngineTool({ ...shipped, name: 'retired_tool' });
    await db.engine.saveEngineTool({ ...shipped, name: 'my_own_tool', ownerId: 'owner-seeds' });

    await seedEngineTools(db.engine);

    const names = (await db.engine.getEngineTools()).map((tool) => tool.name);
    expect(names).not.toContain('retired_tool');
    expect(names).toEqual(arrayWith(ENGINE_TOOL_SEEDS.map((seed) => seed.name)));
    expect((await db.engine.getEngineTools('owner-seeds')).map((tool) => tool.name)).toContain('my_own_tool');
  });
});
