export interface OpenRouterNotice { kind: 'success' | 'error'; message: string }

export function openRouterNoticeFrom(search: string): OpenRouterNotice | null {
  const params = new URLSearchParams(search)
  if (params.get('openrouterConnected')) return { kind: 'success', message: 'OpenRouter is connected with a key on your own OpenRouter account. Its models are in your list, and what they cost is billed there.' }
  const problem = params.get('openrouterError')
  return problem ? { kind: 'error', message: problem } : null
}

export function withoutOpenRouterNotice(search: string): string {
  const params = new URLSearchParams(search)
  params.delete('openrouterConnected')
  params.delete('openrouterError')
  const rest = params.toString()
  return rest ? `?${rest}` : ''
}
