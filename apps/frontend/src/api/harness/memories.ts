import { api } from '../client'

export const memoryKeys = {
  list: () => ['harness-memories'] as const,
  consolidation: () => ['harness-memories', 'consolidation'] as const,
}

export const listMemories = () => api.get('/harness/memories').then((r) => r.data)
export const getConsolidation = () =>
  api.get('/harness/memories/consolidation').then((r) => r.data)
export const createMemory = (body: unknown) =>
  api.post('/harness/memories', body).then((r) => r.data)
export const updateMemory = (id: string, body: unknown) =>
  api.put(`/harness/memories/${id}`, body).then((r) => r.data)
export const approveMemory = (id: string, body?: unknown) =>
  api.put(`/harness/memories/${id}/approve`, body ?? {}).then((r) => r.data)
export const promoteMemory = (id: string, body?: unknown) =>
  api.put(`/harness/memories/${id}/promote`, body ?? {}).then((r) => r.data)
export const deleteMemory = (id: string) =>
  api.delete(`/harness/memories/${id}`).then((r) => r.data)
