import { builtInCatalogue } from '../nodes/index.js';
import { BuilderError } from '../builder/runtime.js';
import { groupBuilder, procedureBuilder } from '../builder/typed.js';
import type { Exits, GroupBody, GroupInfo, ProcedureBody, ProcedureMeta, Sockets } from '../builder/types.generated.js';
import type { GroupDefinition, Procedure } from '../schema.js';

export function defineGroup<const I extends Sockets = Record<never, never>, const O extends Sockets = Record<never, never>, const E extends Exits = Record<never, never>>(
  id: string,
  info: GroupInfo<I, O, E>,
  build: (g: GroupBody<I, O, E>) => void,
): GroupDefinition {
  return groupBuilder({ catalogue: builtInCatalogue() })(id, info, build);
}

export function defineProcedure(groups: readonly GroupDefinition[], meta: ProcedureMeta, build: (p: ProcedureBody) => void): Procedure {
  const built = procedureBuilder({ catalogue: builtInCatalogue(), groups })(meta, build);
  if (built.unplaced.length > 0) {
    throw new BuilderError(`procedure "${meta.id}" never places ${built.unplaced.map((node) => `"${node}"`).join(', ')} — add them to p.layout(…)`);
  }
  return built.procedure;
}
