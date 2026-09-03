import { postStream, type StreamResponse } from './client'

export interface ChatTurnRequest {
  messages: { role: string; content: string }[]
  stream: true
  modelId?: string | undefined
  branchId?: string | undefined
  mode?: string | undefined
  [key: string]: unknown
}

export const openChatStream = (
  body: ChatTurnRequest,
  signal?: AbortSignal,
): Promise<StreamResponse> =>
  postStream('/chat', body, signal)
