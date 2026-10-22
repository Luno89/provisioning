import { describe, expect, it } from 'vitest';
import { grantsFrom, toolsOf, type PersonaRecord } from '@koala/agent-engine';
import { testDatabase } from '../../platform/lib/test-database.js';
import { migrateAgentTools } from './tool-grant-migration.js';

const shipped = grantsFrom({ executor: ['run_command', 'read_file', 'write_file'] });
const builtIn = [{ slug: 'executor', name: 'executor' }] as PersonaRecord[];
const row = (ownerId: string | undefined, slug: string, tools: string[] | undefined): PersonaRecord =>
  ({ slug, ...(ownerId ? { ownerId } : {}), name: slug, ...(tools ? { tools } : {}) }) as unknown as PersonaRecord;

async function migrated(rows: PersonaRecord[]) {
  const db = await testDatabase();
  for (const one of rows) await db.saveEnginePersona(one);
  const report = await migrateAgentTools(db, builtIn, shipped, '2026-10-12T00:00:00Z');
  return { db, report };
}

describe('moving stored tool lists to grants', () => {
  it('keeps every shape holding exactly the tools it held: an own agent, an own copy that added, one that removed, an empty list', async () => {
    const before = {
      helper: ['read_file', 'search_web'],
      executor: ['run_command', 'read_file', 'write_file', 'browser'],
    };
    const { db, report } = await migrated([
      row('u1', 'helper', before.helper),
      row('u1', 'executor', before.executor),
      row('u2', 'executor', ['run_command']),
      row('u3', 'quiet', []),
    ]);

    expect(toolsOf('helper', shipped, await db.getToolGrants('u1'))).toEqual(before.helper);
    expect(toolsOf('executor', shipped, await db.getToolGrants('u1'))).toEqual(before.executor);
    expect(toolsOf('executor', shipped, await db.getToolGrants('u2'))).toEqual(['run_command']);
    expect(toolsOf('quiet', shipped, await db.getToolGrants('u3'))).toEqual([]);
    expect(report).toEqual({ agents: 4, granted: 3, revoked: 2, copiesDropped: 2 });
  });

  it('leaves no stored agent with a tool list, and running again changes nothing', async () => {
    const { db } = await migrated([row('u1', 'helper', ['read_file']), row(undefined, 'retired', ['read_file'])]);
    expect((await db.getEnginePersonas()).some((one) => 'tools' in one)).toBe(false);
    const grants = await db.getToolGrants('u1');

    expect(await migrateAgentTools(db, builtIn, shipped, '2026-10-13T00:00:00Z')).toEqual({ agents: 0, granted: 0, revoked: 0, copiesDropped: 0 });
    expect(await db.getToolGrants('u1')).toEqual(grants);
  });

  it('drops a copy of a built-in that differed only in its tools, so it stays built in, and keeps one that differs otherwise', async () => {
    const { db } = await migrated([
      row('u1', 'executor', ['run_command', 'browser']),
      { ...row('u2', 'executor', ['run_command']), prompt: 'Mine.' } as PersonaRecord,
    ]);

    expect((await db.getEnginePersonas()).map((one) => [one.ownerId, one.slug])).toEqual([['u2', 'executor']]);
    expect(toolsOf('executor', shipped, await db.getToolGrants('u1'))).toEqual(['run_command', 'browser']);
    expect(toolsOf('executor', shipped, await db.getToolGrants('u2'))).toEqual(['run_command']);
  });

  it('says why each moved grant exists', async () => {
    const { db } = await migrated([row('u1', 'helper', ['read_file'])]);
    expect(await db.getToolGrants('u1')).toEqual([
      { ownerId: 'u1', agent: 'helper', tool: 'read_file', grantedAt: '2026-10-12T00:00:00Z', why: 'held by this agent before tools were granted' },
    ]);
  });
});
