import { api } from './client'

/** The host nginx config, edited as one blob of text. */

export const nginxKeys = {
  config: () => ['nginx-config'] as const,
}

export const getNginxConfig = (): Promise<{ content: string }> =>
  api.get<{ content: string }>('/nginx/config').then((r) => r.data)

/** Writes it back AND reloads nginx — the route does both, which is why there is no separate call. */
export const saveNginxConfig = (content: string): Promise<void> =>
  api.post('/nginx/config', { content }).then(() => undefined)
