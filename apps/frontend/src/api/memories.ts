import { api } from './client'

export const memoryKeys = {
  list: () => ['memories'] as const,
  consolidation: () => ['memories', 'consolidation'] as const,
}

export const listMemories = () => api.get('/memories').then((r) => r.data)
export const getConsolidation = () => api.get('/memories/consolidation').then((r) => r.data)
export const createMemory = (body: unknown) => api.post('/memories', body).then((r) => r.data)
export const updateMemory = (id: string, body: unknown) => api.put(`/memories/${id}`, body).then((r) => r.data)
export const approveMemory = (id: string, body?: unknown) => api.put(`/memories/${id}/approve`, body ?? {}).then((r) => r.data)
export const promoteMemory = (id: string, body?: unknown) => api.put(`/memories/${id}/promote`, body ?? {}).then((r) => r.data)
export const deleteMemory = (id: string) => api.delete(`/memories/${id}`).then((r) => r.data)
