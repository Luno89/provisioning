import type { Persona, ProcedureSource } from '@koala/agent-engine';
import { CODE_KIND } from '@koala/agent-engine/procedure';
import {
  BUILT_IN_GROUPS,
  builtInCatalogue,
  formatProcedureProblems,
  readAndCheckProcedure,
  type Procedure,
} from '@koala/agent-engine/procedure';
import { refuse, type ToolHandler, type ToolOutcome } from '@koala/engine-core';

export interface ProcedureSourceStore {
  get(ownerId: string, id: string): Promise<ProcedureSource | undefined>;
  save(source: ProcedureSource): Promise<void>;
}

export interface ProcedureScope {
  procedures(ownerId: string): Promise<(Procedure & { ownerId?: string | undefined })[]>;
  personas(ownerId: string): Promise<Persona[]>;
  toolNames(ownerId: string): Promise<string[]>;
}

export interface ProcedureToolOptions {
  store: ProcedureSourceStore;
  scope: ProcedureScope;
  now?: (() => string) | undefined;
}

export type ProcedureToolsOptions = ProcedureToolOptions;

const asString = (parsed: Record<string, unknown>, key: string): string | undefined => {
  const value = parsed[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
};

const sourceOf = (parsed: Record<string, unknown>): string | Record<string, unknown> | undefined => {
  const value = parsed.source;
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
};

const withoutOwner = ({ ownerId: _ownerId, ...procedure }: Procedure & { ownerId?: string | undefined }): Procedure => procedure;

export function createProcedureTools(options: ProcedureToolOptions): Record<string, ToolHandler> {
  const now = options.now ?? (() => new Date().toISOString());
  const catalogue = builtInCatalogue();

  const check = async (ownerId: string, source: string | Record<string, unknown>) => {
    const [personas, tools] = await Promise.all([options.scope.personas(ownerId), options.scope.toolNames(ownerId)]);
    const read = readAndCheckProcedure(source, {
      catalogue,
      groups: BUILT_IN_GROUPS,
      known: { agents: new Set(personas.map((persona) => persona.slug)), tools: new Set(tools) },
    });

    if (!read.ok) return read;
    const written = read.procedure.nodes.filter((node) => node.kind === CODE_KIND).map((node) => node.id);
    if (written.length === 0) return read;

    return {
      ok: false as const,
      problems: written.map((node) => ({
        severity: 'error' as const,
        node,
        message: 'is a code node, and a procedure written from here may not run code a person has not read',
      })),
    };
  };

  return {
    async list_references({ caller }): Promise<ToolOutcome> {
      const ownerId = caller.ownerId ?? '';
      const [personas, tools] = await Promise.all([options.scope.personas(ownerId), options.scope.toolNames(ownerId)]);

      const text = [
        'TOOLS a Call Tool node can call',
        ...[...tools].sort().map((name) => `- ${name}`),
        '',
        'PERSONAS a Delegate or Fan Out node can hand work to',
        ...personas.slice().sort((a, b) => a.slug.localeCompare(b.slug)).map((one) => `- ${one.slug}: ${one.description}`),
        '',
        'NODE KINDS',
        ...catalogue.list().map((definition) => `- ${definition.kind}: ${definition.title}`),
        '',
        'GROUPS',
        ...BUILT_IN_GROUPS.map((group) => `- ${group.id}: ${group.title}`),
      ].join('\n');

      return { ok: true, digest: text, content: text };
    },

    async read_procedure({ parsed, caller }): Promise<ToolOutcome> {
      const ownerId = caller.ownerId ?? '';
      const all = await options.scope.procedures(ownerId);
      const id = asString(parsed, 'procedure');

      if (!id) {
        const text = all
          .map((one) => `- ${one.id} v${one.version}${one.ownerId ? ' (your copy)' : ''}: ${one.name}`)
          .sort()
          .join('\n');
        return { ok: true, digest: text || 'there are no procedures yet', content: text };
      }

      const found = all.find((one) => one.id === id);
      if (!found) return refuse(`there is no procedure called "${id}"`);

      const text = JSON.stringify(withoutOwner(found), null, 2);
      return { ok: true, digest: text, content: text };
    },

    async check_procedure({ parsed, caller }): Promise<ToolOutcome> {
      const source = sourceOf(parsed);
      if (!source) return refuse('this call needs a "source"');

      const checked = await check(caller.ownerId ?? '', source);
      if (!checked.ok) {
        const report = formatProcedureProblems(checked.problems);
        return { ok: false, digest: report, content: report };
      }

      const warnings = checked.problems.length > 0 ? `\n${formatProcedureProblems(checked.problems)}` : '';
      const said = `checks clean: ${checked.procedure.id}${warnings}`;
      return { ok: true, digest: said, content: said };
    },

    async save_procedure({ parsed, caller }): Promise<ToolOutcome> {
      const source = sourceOf(parsed);
      if (!source) return refuse('this call needs a "source"');

      const ownerId = caller.ownerId;
      if (!ownerId) return refuse('this run has no owner to save a procedure for');

      const checked = await check(ownerId, source);
      if (!checked.ok) {
        const report = formatProcedureProblems(checked.problems);
        return { ok: false, digest: `not saved — it does not check clean:\n${report}`, content: report };
      }

      const existing = await options.store.get(ownerId, checked.procedure.id);
      const version = String((Number(existing?.version) || 0) + 1);
      const procedure: Procedure = { ...checked.procedure, version };

      await options.store.save({
        id: procedure.id,
        ownerId,
        version,
        source: JSON.stringify(procedure, null, 2),
        updatedAt: now(),
      });

      const said = `saved as your own copy: ${procedure.id} v${version}`;
      return { ok: true, digest: said, content: said };
    },
  };
}
