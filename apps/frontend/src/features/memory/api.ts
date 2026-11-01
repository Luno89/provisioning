import { api } from '../../api/client'
import type { ConsolidationReport, MemoryItem } from './types'

export const memoryKeys = {
  list: () => ['memories'] as const,
  consolidation: () => ['memories', 'consolidation'] as const,
}

export const listMemories = (): Promise<MemoryItem[]> => api.get<MemoryItem[]>('/memories').then((r) => r.data)
export const getConsolidation = (): Promise<ConsolidationReport | null> => api.get<ConsolidationReport | null>('/memories/consolidation').then((r) => r.data)
export const createMemory = (body: unknown): Promise<void> => api.post('/memories', body).then(() => undefined)
export const updateMemory = (id: string, body: unknown): Promise<void> => api.put(`/memories/${id}`, body).then(() => undefined)
export const approveMemory = (id: string, body?: unknown): Promise<void> => api.put(`/memories/${id}/approve`, body ?? {}).then(() => undefined)
export const promoteMemory = (id: string, body?: unknown): Promise<void> => api.put(`/memories/${id}/promote`, body ?? {}).then(() => undefined)
export const deleteMemory = (id: string): Promise<void> => api.delete(`/memories/${id}`).then(() => undefined)
