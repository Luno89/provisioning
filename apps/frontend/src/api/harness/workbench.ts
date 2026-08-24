import { api } from '../client'

/**
 * The workbench pod — a real container a run can execute in.
 *
 * `open` stands one up (or returns the running one), `exec` runs a command in it, `reset` wipes
 * its filesystem without tearing it down, and `delete` removes it. `reset` exists separately
 * because standing one up is slow and most of the time the pod is fine and the state is not.
 */

export const workbenchKeys = { session: (id?: string) => ['workbench', id] as const }

export const openWorkbench = (body?: unknown) =>
  api.post('/harness/workbench/open', body ?? {}).then((r) => r.data)
export const execInWorkbench = (body: unknown) =>
  api.post('/harness/workbench/exec', body).then((r) => r.data)
export const resetWorkbench = (body?: unknown) =>
  api.post('/harness/workbench/reset', body ?? {}).then((r) => r.data)
export const deleteWorkbench = (id: string) =>
  api.delete(`/harness/workbench/${id}`).then((r) => r.data)
