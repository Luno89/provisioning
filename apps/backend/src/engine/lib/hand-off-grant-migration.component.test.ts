import { describe, expect, it } from 'vitest';
import { handOffsShippedBy, toolsOf, type PersonaRecord } from '@koala/agent-engine';
import { testDatabase } from '../../platform/lib/test-database.js';
import { migrateAgentHandOffs } from './hand-off-grant-migration.js';

const builtIn = [{ slug: 'delivery', name: 'delivery', agents: ['research', 'executor'] }] as PersonaRecord[];
const shipped = handOffsShippedBy(builtIn);
const row = (ownerId: string | undefined, slug: string, agents: string[] | undefined): PersonaRecord =>
  ({ slug, ...(ownerId ? { ownerId } : {}), name: slug, ...(agents ? { agents } : {}) }) as PersonaRecord;

async function migrated(rows: PersonaRecord[]) {
  const db = await testDatabase();
  for (const one of rows) await db.engine.saveEnginePersona(one);
  const report = await migrateAgentHandOffs(db.engine, builtIn, '2026-11-21T00:00:00Z');
  return { db, report };
}

describe('moving stored hand-off lists to grants', () => {
  it('keeps every agent handing work to exactly whom it did: an own agent, a copy of a built-in that took one away and added one', async () => {
    const { db, report } = await migrated([row('u1', 'helper', ['research']), row('u1', 'delivery', ['research', 'judge'])]);

    expect(toolsOf('helper', shipped, await db.engine.getToolGrants('u1'), 'agent')).toEqual(['research']);
    expect(toolsOf('delivery', shipped, await db.engine.getToolGrants('u1'), 'agent')).toEqual(['research', 'judge']);
    expect(toolsOf('delivery', shipped, await db.engine.getToolGrants('u2'), 'agent')).toEqual(['research', 'executor']);
    expect(report).toEqual({ agents: 2, granted: 2, revoked: 1 });
  });

  it('leaves no stored agent with a hand-off list, and running again changes nothing', async () => {
    const { db } = await migrated([row('u1', 'helper', ['research']), row(undefined, 'retired', ['research'])]);
    expect((await db.engine.getEnginePersonas()).some((one) => 'agents' in one)).toBe(false);
    expect(await migrateAgentHandOffs(db.engine, builtIn, '2026-11-21T00:00:00Z')).toEqual({ agents: 0, granted: 0, revoked: 0 });
  });
});
