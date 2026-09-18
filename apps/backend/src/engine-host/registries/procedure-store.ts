import {
  BUILT_IN_GROUPS,
  BUILT_IN_PROCEDURES,
  builtInCatalogue,
  formatProcedureProblems,
  readAndCheckProcedure,
  type GroupDefinition,
  type NodeCatalogue,
  type Procedure,
} from '@koala/agent-engine/procedure';
import type { ProcedureSource } from '@koala/agent-engine';
import { withBuiltIns } from '../../lib/ownership.js';

export interface ProcedureReader {
  list(ownerId?: string): Promise<ProcedureSource[]>;
}

export type OwnedProcedure = Procedure & { ownerId?: string | undefined };

export interface ProcedureStoreOptions {
  sources: ProcedureReader;
  builtIns?: readonly Procedure[] | undefined;
  catalogue?: NodeCatalogue | undefined;
  groups?: readonly GroupDefinition[] | undefined;
}

export interface UnreadableProcedure {
  id: string;
  report: string;
}

export interface ProcedureStore {
  list(ownerId: string): Promise<OwnedProcedure[]>;
  get(ownerId: string, id: string): Promise<OwnedProcedure | undefined>;
  problems(ownerId: string): Promise<UnreadableProcedure[]>;
}

const cacheKey = (row: ProcedureSource): string => `${row.ownerId ?? 'builtin'}:${row.id}:${row.updatedAt}`;

export function createProcedureStore(options: ProcedureStoreOptions): ProcedureStore {
  const builtIns = options.builtIns ?? BUILT_IN_PROCEDURES;
  const catalogue = options.catalogue ?? builtInCatalogue();
  const groups = options.groups ?? BUILT_IN_GROUPS;
  const cache = new Map<string, { procedure?: Procedure; report?: string }>();

  const build = async (ownerId: string) => {
    const rows = (await options.sources.list(ownerId)).filter((row) => row.ownerId === ownerId);
    const owned: OwnedProcedure[] = [];
    const problems: UnreadableProcedure[] = [];

    for (const row of rows) {
      const key = cacheKey(row);
      let entry = cache.get(key);
      if (!entry) {
        const read = readAndCheckProcedure(row.source, { catalogue, groups });
        entry = read.ok ? { procedure: read.procedure } : { report: formatProcedureProblems(read.problems) };
        cache.set(key, entry);
      }

      if (entry.procedure) owned.push({ ...entry.procedure, ownerId });
      else problems.push({ id: row.id, report: entry.report ?? 'could not be read' });
    }

    const all = withBuiltIns<OwnedProcedure>([...builtIns, ...owned], ownerId, (procedure) => procedure.id);
    return { procedures: all.map((procedure) => structuredClone(procedure)), problems };
  };

  return {
    async list(ownerId) {
      return (await build(ownerId)).procedures;
    },
    async get(ownerId, id) {
      return (await build(ownerId)).procedures.find((procedure) => procedure.id === id);
    },
    async problems(ownerId) {
      return (await build(ownerId)).problems;
    },
  };
}
