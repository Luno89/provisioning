import type { Procedure, ProcedureProblem, TrackRecord } from '@koala/agent-engine/procedure'
import { api } from './client'

export interface ProcedureSummary {
  id: string
  version: string
  name: string
  describe: string
  mine: boolean
}

export interface UnreadableProcedure {
  id: string
  report: string
}

export const procedureKeys = {
  all: () => ['procedures'] as const,
  list: () => ['procedures', 'list'] as const,
  one: (id: string) => ['procedures', 'one', id] as const,
  trackRecord: (id: string) => ['procedures', 'track-record', id] as const,
}

export async function listProcedures(): Promise<{ procedures: ProcedureSummary[]; unreadable: UnreadableProcedure[] }> {
  const { data } = await api.get<{ procedures: ProcedureSummary[]; unreadable: UnreadableProcedure[] }>('/procedures')
  return data
}

export async function getProcedure(id: string): Promise<{ procedure: Procedure; mine: boolean }> {
  const { data } = await api.get<{ procedure: Procedure; mine: boolean }>(`/procedures/${encodeURIComponent(id)}`)
  return data
}

export async function checkProcedureOnServer(procedure: Procedure): Promise<ProcedureProblem[]> {
  const { data } = await api.post<{ problems: ProcedureProblem[] }>('/procedures/check', procedure)
  return data.problems
}

export type SaveOutcome =
  | { saved: true; procedure: Procedure; problems: ProcedureProblem[] }
  | { saved: false; problems: ProcedureProblem[] }

export async function saveProcedure(procedure: Procedure): Promise<SaveOutcome> {
  const response = await api.put<{ procedure: Procedure; problems: ProcedureProblem[] }>(
    `/procedures/${encodeURIComponent(procedure.id)}`,
    procedure,
    { validateStatus: (status) => status < 300 || status === 400 },
  )
  if (response.status === 400) return { saved: false, problems: response.data.problems ?? [] }
  return { saved: true, procedure: response.data.procedure, problems: response.data.problems }
}

export async function deleteProcedure(id: string): Promise<void> {
  await api.delete(`/procedures/${encodeURIComponent(id)}`)
}

export async function getTrackRecords(id: string): Promise<TrackRecord[]> {
  const { data } = await api.get<{ records: TrackRecord[] }>(`/procedures/${encodeURIComponent(id)}/track-record`)
  return data.records
}
