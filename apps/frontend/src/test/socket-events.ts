export const socketHandlers = new Map<string, (payload?: unknown) => unknown>()

export const useSocketEvent = <T,>(event: string, handler: (payload: T) => unknown): void => { socketHandlers.set(event, handler as (payload?: unknown) => unknown) }
