import type { ProcedureSource } from './procedure-source.js';

export interface StoredProcedures {
  getProcedures(ownerId?: string): Promise<ProcedureSource[]>;
  deleteProcedure(ownerId: string | undefined, id: string): Promise<void>;
}

export async function retireStoredBuiltInProcedures(store: StoredProcedures): Promise<number> {
  const stored = await store.getProcedures();
  const builtIn = stored.filter((row) => row.ownerId === undefined);
  for (const row of builtIn) await store.deleteProcedure(undefined, row.id);
  return builtIn.length;
}
