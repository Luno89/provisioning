import { api } from '../client'

export const authorChat = (body: unknown) =>
  api.post('/harness/author/chat', body).then((r) => r.data)

export const validateAuthored = (body: unknown) =>
  api.post('/harness/author/validate', body).then((r) => r.data)
