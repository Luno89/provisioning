import { api } from '../client'

export const workbenchKeys = { session: (id?: string) => ['workbench', id] as const }

export const openWorkbench = (body?: unknown) =>
  api.post('/harness/workbench/open', body ?? {}).then((r) => r.data)
export const execInWorkbench = (body: unknown) =>
  api.post('/harness/workbench/exec', body).then((r) => r.data)
export const resetWorkbench = (body?: unknown) =>
  api.post('/harness/workbench/reset', body ?? {}).then((r) => r.data)
export const deleteWorkbench = (id: string) =>
  api.delete(`/harness/workbench/${id}`).then((r) => r.data)
