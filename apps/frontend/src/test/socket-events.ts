export const socketHandlers = new Map<string, (payload?: unknown) => void>()

export const useSocketEvent = <T,>(event: string, handler: (payload: T) => void): void => { socketHandlers.set(event, handler as (payload?: unknown) => void) }
