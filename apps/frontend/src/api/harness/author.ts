import { api } from '../client'

/**
 * Authoring an experiment by talking to a model.
 *
 * `validate` is deliberately its own call rather than something `chat` returns: the editor
 * validates on demand while the user is still typing, and folding it into the chat turn would
 * mean a model round-trip to find out that a task file has a typo.
 */

export const authorChat = (body: unknown) =>
  api.post('/harness/author/chat', body).then((r) => r.data)

export const validateAuthored = (body: unknown) =>
  api.post('/harness/author/validate', body).then((r) => r.data)
