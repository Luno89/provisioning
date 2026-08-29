import { api } from './client'

export const nginxKeys = {
  config: () => ['nginx-config'] as const,
}

export const getNginxConfig = (): Promise<{ content: string }> =>
  api.get<{ content: string }>('/nginx/config').then((r) => r.data)

export const saveNginxConfig = (content: string): Promise<void> =>
  api.post('/nginx/config', { content }).then(() => undefined)
