import { api } from '../../../api/client'

export type ChatItemKind = 'story' | 'feature'

export const itemChatKeys = {
  of: (kind: ChatItemKind, id: string) => ['item-chat', kind, id] as const,
}

export const openItemChat = (kind: ChatItemKind, id: string): Promise<{ id: string; title: string }> =>
  api.post<{ id: string; title: string }>(`/items/${kind}/${encodeURIComponent(id)}/chat`, {}).then((r) => r.data)

