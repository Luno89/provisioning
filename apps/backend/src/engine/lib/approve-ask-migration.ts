import type { ProcedureSource } from './procedure-source.js';

export const APPROVE_ASK_MIGRATION = 'approve-ask-setting-dropped';

export interface AskSettingStore {
  getProcedures(ownerId?: string): Promise<ProcedureSource[]>;
  saveProcedure(source: ProcedureSource): Promise<void>;
}

type RawNode = { kind?: unknown; settings?: Record<string, unknown> };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nodesOf = (body: unknown): RawNode[] => (isRecord(body) && Array.isArray(body.nodes) ? body.nodes.filter(isRecord) as RawNode[] : []);

function withoutAsk(source: string): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  const groups = Array.isArray(raw.groups) ? raw.groups : [];
  let changed = false;
  for (const node of [...nodesOf(raw), ...groups.flatMap(nodesOf)]) {
    if (node.kind !== 'approve-tool-calls' || !isRecord(node.settings) || !('ask' in node.settings)) continue;
    delete node.settings.ask;
    changed = true;
  }
  return changed ? JSON.stringify(raw, null, 2) : undefined;
}

export async function dropApproveAskSetting(store: AskSettingStore, now: string): Promise<{ procedures: number }> {
  let procedures = 0;
  for (const row of await store.getProcedures()) {
    const source = withoutAsk(row.source);
    if (source === undefined) continue;
    await store.saveProcedure({ ...row, source, updatedAt: now });
    procedures += 1;
  }
  return { procedures };
}
