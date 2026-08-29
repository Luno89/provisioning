import { api } from '../client'
import type { ExperimentSummary, Experiment as ExperimentDetail } from '@koala/harness-types'

export const experimentKeys = {
  all: ['experiments'] as const,
  list: () => [...experimentKeys.all, 'list'] as const,
  detail: (id: string) => ['experiment', id] as const,
}

export const listExperiments = (): Promise<ExperimentSummary[]> =>
  api.get<ExperimentSummary[]>('/harness/experiments').then((r) => r.data)

export const runExperiment = (id: string) =>
  api.post(`/harness/experiments/${id}/run`, {}).then((r) => r.data)

export const stopExperiment = (id: string) =>
  api.post(`/harness/experiments/${id}/stop`, {}).then((r) => r.data)

export const duplicateExperiment = (id: string) =>
  api.post(`/harness/experiments/${id}/duplicate`, {}).then((r) => r.data)

export const deleteExperiment = (id: string) =>
  api.delete(`/harness/experiments/${id}`).then((r) => r.data)

export const updateExperiment = (id: string, body: unknown) =>
  api.put(`/harness/experiments/${id}`, body).then((r) => r.data)

export const createExperiment = (body: unknown) =>
  api.post('/harness/experiments', body).then((r) => r.data)

export const getExperiment = (id: string): Promise<ExperimentDetail> =>
  api.get<ExperimentDetail>(`/harness/experiments/${id}`).then((r) => r.data)
