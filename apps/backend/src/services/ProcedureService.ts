import {
  BUILT_IN_GROUPS,
  builtInCatalogue,
  checkProcedure,
  procedureErrors,
  readProcedure,
  type Procedure,
  type ProcedureProblem,
} from '@koala/agent-engine/procedure';
import type { ProcedureSource } from '@koala/agent-engine';
import { builderCodeToProcedure, placeUnplaced } from '@koala/agent-engine/procedure-builder';
import type { OwnedProcedure, UnreadableProcedure } from '../engine-host/registries/procedure-store.js';
import { trackRecordsByModel, type RunEffort, type TrackRecord } from '@koala/agent-engine/procedure';
import { requiredGrants, type RequiredGrant } from '@koala/agent-engine/procedure';

export interface ProcedureServiceOptions {
  procedures: {
    list(ownerId: string): Promise<OwnedProcedure[]>;
    problems(ownerId: string): Promise<UnreadableProcedure[]>;
  };
  sources: {
    get(ownerId: string, id: string): Promise<ProcedureSource | undefined>;
    save(source: ProcedureSource): Promise<void>;
    delete(ownerId: string, id: string): Promise<void>;
  };
  known(ownerId: string): Promise<{ tools: ReadonlySet<string>; agents: ReadonlySet<string> }>;
  effort: { list(ownerId: string, procedureId: string): Promise<RunEffort[]> };
  now?: (() => string) | undefined;
}

export interface ProcedureSummary {
  id: string;
  version: string;
  name: string;
  describe: string;
  mine: boolean;
  requires: RequiredGrant[];
}

export type SaveOutcome =
  | { saved: true; procedure: Procedure; problems: ProcedureProblem[] }
  | { saved: false; problems: ProcedureProblem[] };

const withoutOwner = ({ ownerId: _ownerId, ...procedure }: OwnedProcedure): Procedure => procedure;

export class ProcedureService {
  private readonly catalogue = builtInCatalogue();

  constructor(private readonly options: ProcedureServiceOptions) {}

  async list(ownerId: string): Promise<{ procedures: ProcedureSummary[]; unreadable: UnreadableProcedure[] }> {
    const [procedures, unreadable] = await Promise.all([
      this.options.procedures.list(ownerId),
      this.options.procedures.problems(ownerId),
    ]);

    return {
      procedures: procedures
        .map((procedure) => ({
          id: procedure.id,
          version: procedure.version,
          name: procedure.name,
          describe: procedure.describe,
          mine: procedure.ownerId === ownerId,
          requires: requiredGrants(procedure, BUILT_IN_GROUPS),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      unreadable,
    };
  }

  async get(ownerId: string, id: string): Promise<{ procedure: Procedure; mine: boolean } | undefined> {
    const found = (await this.options.procedures.list(ownerId)).find((procedure) => procedure.id === id);
    return found ? { procedure: withoutOwner(found), mine: found.ownerId === ownerId } : undefined;
  }

  async trackRecords(ownerId: string, id: string): Promise<TrackRecord[]> {
    return trackRecordsByModel(await this.options.effort.list(ownerId, id));
  }

  async check(ownerId: string, source: unknown): Promise<ProcedureProblem[]> {
    const read = readProcedure(source as Record<string, unknown>);
    if (!read.ok) return read.problems;
    return checkProcedure(read.procedure, { catalogue: this.catalogue, groups: BUILT_IN_GROUPS, known: await this.options.known(ownerId) });
  }

  async save(ownerId: string, id: string, source: unknown): Promise<SaveOutcome> {
    const read = readProcedure(source as Record<string, unknown>);
    if (!read.ok) return { saved: false, problems: read.problems };
    if (read.procedure.id !== id) {
      return { saved: false, problems: [{ severity: 'error', message: `this procedure is "${read.procedure.id}", not "${id}"` }] };
    }

    const problems = checkProcedure(read.procedure, { catalogue: this.catalogue, groups: BUILT_IN_GROUPS, known: await this.options.known(ownerId) });
    if (procedureErrors(problems).length > 0) return { saved: false, problems };

    const existing = await this.options.sources.get(ownerId, id);
    const version = String((Number(existing?.version) || 0) + 1);
    const procedure: Procedure = { ...read.procedure, version };

    await this.options.sources.save({
      id,
      ownerId,
      version,
      source: JSON.stringify(procedure, null, 2),
      updatedAt: this.options.now?.() ?? new Date().toISOString(),
    });

    return { saved: true, procedure, problems };
  }

  async saveBuilderCode(ownerId: string, id: string, code: unknown): Promise<SaveOutcome> {
    if (typeof code !== 'string') return { saved: false, problems: [{ severity: 'error', message: 'send the builder code as "code"' }] };
    const parsed = builderCodeToProcedure(code, { catalogue: this.catalogue, groups: BUILT_IN_GROUPS });
    if (!parsed.ok) {
      return { saved: false, problems: parsed.problems.map((problem) => ({ severity: 'error', message: `line ${problem.line}, column ${problem.column}: ${problem.message}` })) };
    }
    const previous = await this.get(ownerId, id);
    return this.save(ownerId, id, placeUnplaced(parsed.procedure, parsed.unplaced, previous?.procedure));
  }

  async remove(ownerId: string, id: string): Promise<boolean> {
    const existing = await this.options.sources.get(ownerId, id);
    if (!existing) return false;
    await this.options.sources.delete(ownerId, id);
    return true;
  }
}
