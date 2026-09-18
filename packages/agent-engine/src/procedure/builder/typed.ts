import { createGroupBuilder, createProcedureBuilder, type BuilderOptions, type BuiltProcedure } from './runtime.js';
import type { Exits, GroupBody, GroupInfo, ProcedureBody, ProcedureMeta, Sockets } from './types.generated.js';
import type { GroupDefinition } from '../schema.js';

export function procedureBuilder(options: BuilderOptions) {
  const build = createProcedureBuilder(options);
  return (meta: ProcedureMeta, body: (p: ProcedureBody) => void): BuiltProcedure => build(meta as never, body as never);
}

export function groupBuilder(options: BuilderOptions) {
  const build = createGroupBuilder(options);
  return <const I extends Sockets = Record<never, never>, const O extends Sockets = Record<never, never>, const E extends Exits = Record<never, never>>(
    id: string,
    info: GroupInfo<I, O, E>,
    body: (g: GroupBody<I, O, E>) => void,
  ): GroupDefinition => build(id, info as never, body as never);
}
