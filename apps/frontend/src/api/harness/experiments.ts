import { api } from '../client'
import type { ExperimentSummary, Experiment as ExperimentDetail } from '@koala/harness-types'

/**
 * The Lab's experiments.
 *
 * ── WHY THIS MIRRORS `routes/harness/` ──
 * The backend composes six sub-resource routers under `/api/harness` — workbench, author, profile,
 * experiments, tools, memories. This folder is one module per sub-resource, same names. When a
 * route moves on one side, there is exactly one file on the other that has to follow, and the
 * compiler says which.
 *
 * ── WHAT MOVED HERE ──
 * `useExperimentDetail` was in `Lab/shared.ts`, which was the right call at the time and is now the
 * wrong one: `shared.ts` is what the eight panels import for the card class and the median helper,
 * and a data-fetching hook living there made every panel that wanted a CSS string also import
 * axios. The docblocks below are its, verbatim — they record measured behaviour, not intent.
 */

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

/**
 * One experiment's full record.
 *
 * A named function rather than an inline `queryFn`, because `useExperimentDetail` is not the only
 * thing that needs to be able to say "fetch THIS experiment" — a test asserting the detail was
 * fetched had to recognise it by URL regex otherwise, which is a second copy of the route shape.
 */
export const getExperiment = (id: string): Promise<ExperimentDetail> =>
  api.get<ExperimentDetail>(`/harness/experiments/${id}`).then((r) => r.data)

