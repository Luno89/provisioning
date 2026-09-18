export interface ProcedureSource {
  id: string;
  ownerId?: string | undefined;
  version: string;
  source: string;
  updatedAt: string;
}

export const procedureKey = (ownerId: string | undefined, id: string): string =>
  `${ownerId ?? 'builtin'}:${id}`;
