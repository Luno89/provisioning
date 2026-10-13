import { api } from './client'

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `GET /api/projects/:id/channel` in apps/backend/src/routes/project-channel.ts.
 */
export interface ProjectChannel {
  channel: { id: string; title: string }
  threads: { id: string; title: string; updatedAt?: string; messageCount: number }[]
}

export const projectChannelKeys = {
  of: (projectId: string) => ['project-channel', projectId] as const,
}

export const getProjectChannel = (projectId: string): Promise<ProjectChannel> =>
  api.get<ProjectChannel>(`/projects/${encodeURIComponent(projectId)}/channel`).then((r) => r.data)

export const postChannelMessage = (conversationId: string, content: string): Promise<void> =>
  api.post(`/conversations/${encodeURIComponent(conversationId)}/messages`, { content }).then(() => undefined)

/** Mirrors `mentionsKoala` in apps/backend/src/lib/conversations.ts. */
export const mentionsKoala = (text: string): boolean => /(^|\s)@koala\b/i.test(text)
