const KEY = 'koala.pending-join'

export interface PendingJoin {
  code: string
  project: string
}

export function rememberJoin(join: PendingJoin): void {
  try { window.localStorage.setItem(KEY, JSON.stringify(join)) } catch { return }
}

export function pendingJoin(): PendingJoin | undefined {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Partial<PendingJoin> | null
    return parsed && typeof parsed.code === 'string' && typeof parsed.project === 'string' ? { code: parsed.code, project: parsed.project } : undefined
  } catch {
    return undefined
  }
}

export function forgetJoin(): void {
  try { window.localStorage.removeItem(KEY) } catch { return }
}

export const safeNext = (next: string | null | undefined): string | undefined => (next && /^\/[^/\\]/.test(next) ? next : undefined)
