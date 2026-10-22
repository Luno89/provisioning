import { api } from '../../../api/client'
import type { SentAttachment } from '../../files'

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `GET /api/projects/:id/channel` in apps/backend/src/projects/routes/project-channel.ts.
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

export const postChannelMessage = (conversationId: string, content: string, attachments: SentAttachment[] = []): Promise<void> =>
  api.post(`/conversations/${encodeURIComponent(conversationId)}/messages`, { content, ...(attachments.length ? { attachments } : {}) }).then(() => undefined)

/** Mirrors `mentionsKoala` in apps/backend/src/engine/lib/conversations.ts. */
export const mentionsKoala = (text: string): boolean => /(^|\s)@koala\b/i.test(text)
