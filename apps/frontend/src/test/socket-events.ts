export const socketHandlers = new Map<string, () => void>()

export const useSocketEvent = (event: string, handler: () => void): void => { socketHandlers.set(event, handler) }
