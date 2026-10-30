export const SERVER_CLOSED = 'io server disconnect'

export const tryAgainAfter = (reason: string): boolean => reason === SERVER_CLOSED
