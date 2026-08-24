import { api } from '../client'

/** The tool catalogue the harness offers a run. */

export const toolKeys = { list: () => ['harness-tools'] as const }

export const listTools = () => api.get('/harness/tools').then((r) => r.data)
export const createTool = (body: unknown) => api.post('/harness/tools', body).then((r) => r.data)
export const updateTool = (id: string, body: unknown) =>
  api.put(`/harness/tools/${id}`, body).then((r) => r.data)
export const deleteTool = (id: string) => api.delete(`/harness/tools/${id}`).then((r) => r.data)
