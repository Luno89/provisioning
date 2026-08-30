import { describe, it, expect } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { seedTools } from '../lib/tool-seeds.js';
import { ToolService } from './ToolService.js';

describe('ToolService', () => {
  it('serves a user the seeded catalogue, with their own edit shadowing the shipped row', async () => {
    const db = new MemoryDB();
    expect(await db.getTools()).toEqual([]);
    await seedTools(db);

    const svc = new ToolService(db);
    expect((await svc.list('u1')).map((t) => t.name)).toContain('get_logs');

    const shipped = (await svc.list('u1')).find((t) => t.name === 'get_logs')!;
    await db.saveTool({ ...shipped, id: 'mine', ownerId: 'u1', description: 'my wording' });

    expect((await svc.list('u1')).find((t) => t.name === 'get_logs')!.description).toBe('my wording');
    expect((await svc.list('u2')).find((t) => t.name === 'get_logs')!.description).toBe(shipped.description);
  });
});
