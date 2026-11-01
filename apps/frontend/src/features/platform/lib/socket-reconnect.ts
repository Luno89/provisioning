export const SERVER_CLOSED = 'io server disconnect'

export const UNCHECKED_RETRY_MS = 5_000

export const tryAgainAfter = (reason: string): boolean => reason === SERVER_CLOSED

export const tryAgainAfterRefusal = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null || !('data' in err)) return false
  const { data } = err as { data?: unknown }
  return typeof data === 'object' && data !== null && (data as { tryAgain?: unknown }).tryAgain === true
}
