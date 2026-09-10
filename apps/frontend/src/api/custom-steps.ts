import { api } from './client.js'
import type { CustomStepDefinition } from '../types/grove.js'

export const customStepKeys = {
  list: () => ['custom-steps'] as const,
}

export const listCustomSteps = (): Promise<CustomStepDefinition[]> =>
  api.get<CustomStepDefinition[]>('/custom-steps').then((r) => r.data)

export const createCustomStep = (body: Partial<CustomStepDefinition>): Promise<CustomStepDefinition> =>
  api.post<CustomStepDefinition>('/custom-steps', body).then((r) => r.data)

export const updateCustomStep = (id: string, body: Partial<CustomStepDefinition>): Promise<CustomStepDefinition> =>
  api.put<CustomStepDefinition>(`/custom-steps/${id}`, body).then((r) => r.data)

export const deleteCustomStep = (id: string): Promise<{ deleted: string }> =>
  api.delete<{ deleted: string }>(`/custom-steps/${id}`).then((r) => r.data)
