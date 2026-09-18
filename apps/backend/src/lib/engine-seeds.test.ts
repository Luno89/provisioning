import { describe, it, expect } from 'vitest';
import { ALL_SEEDED_AGENTS } from '@koala/agent-engine';
import { retireStoredBuiltInPersonas } from './built-in-personas.js';
import { retireStoredBuiltInProcedures } from './built-in-procedures.js';
import { ENGINE_TOOL_SEEDS, seedEngineTools } from './engine-tool-seeds.js';
import type { Persona, ToolDefinition } from '@koala/agent-engine';
import type { ProcedureSource } from './procedure-source.js';

function personaStore(rows: Persona[] = []) {
  return {
    rows,
    getEnginePersonas: async () => [...rows],
    deleteEnginePersona: async (ownerId: string | undefined, slug: string) => {
      const idx = rows.findIndex((r) => r.slug === slug && r.ownerId === ownerId);
      if (idx >= 0) rows.splice(idx, 1);
    },
  };
}

function procedureStore(rows: ProcedureSource[] = []) {
  return {
    rows,
    getProcedures: async () => [...rows],
    deleteProcedure: async (ownerId: string | undefined, id: string) => {
      const idx = rows.findIndex((r) => r.id === id && r.ownerId === ownerId);
      if (idx >= 0) rows.splice(idx, 1);
    },
  };
}

function toolStore(rows: ToolDefinition[] = []) {
  return {
    rows,
    getEngineTools: async () => [...rows],
    saveEngineTool: async (row: ToolDefinition) => {
      const idx = rows.findIndex((r) => r.name === row.name && r.ownerId === row.ownerId);
      if (idx >= 0) rows[idx] = row; else rows.push(row);
    },
  };
}

describe('a built-in that changed in code reaches the database', () => {
  it('removes built-in personas from the database, because they ship in code, and keeps every user copy', async () => {
    const builtIns = ALL_SEEDED_AGENTS();
    const mine: Persona = { ...builtIns[0]!, ownerId: 'user-1', prompt: 'mine' };
    const db = personaStore([...builtIns.map((seed) => ({ ...seed })), mine]);

    expect(await retireStoredBuiltInPersonas(db)).toBe(builtIns.length);
    expect(db.rows).toEqual([mine]);
    expect(await retireStoredBuiltInPersonas(db)).toBe(0);
  });

  it('removes built-in procedures from the database, because they ship in code, and keeps every user copy', async () => {
    const row = (id: string, ownerId?: string): ProcedureSource => ({ id, ...(ownerId ? { ownerId } : {}), version: '1', source: '{}', updatedAt: 'then' });
    const db = procedureStore([row('research'), row('delivery'), row('research', 'user-1')]);

    expect(await retireStoredBuiltInProcedures(db)).toBe(2);
    expect(db.rows).toEqual([row('research', 'user-1')]);
    expect(await retireStoredBuiltInProcedures(db)).toBe(0);
  });

  it('rewrites a tool whose guidance moved on, and only that one', async () => {
    const db = toolStore(ENGINE_TOOL_SEEDS.map((seed) => ({ ...seed })));
    db.rows[0] = { ...ENGINE_TOOL_SEEDS[0]!, guidance: 'something older' };

    expect(await seedEngineTools(db)).toBe(1);
    expect(db.rows[0]!.guidance).toBe(ENGINE_TOOL_SEEDS[0]!.guidance);
  });
});

describe('a built-in that did not change is left alone', () => {
  it('writes nothing on a second run', async () => {
    const tools = toolStore();

    await seedEngineTools(tools);

    expect(await seedEngineTools(tools)).toBe(0);
  });

});
