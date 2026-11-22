import { useEffect, useRef } from 'react'
import { io, type Socket } from 'socket.io-client'
import { SOCKET_URL } from '../../../api/client'
import { tryAgainAfter, tryAgainAfterRefusal, UNCHECKED_RETRY_MS } from '../lib/socket-reconnect'

let shared: Socket | null = null
const reconnectedListeners = new Set<() => void>()

const opened = (): Socket => {
  const socket = io(SOCKET_URL, { withCredentials: true, autoConnect: false })
  socket.on('disconnect', (reason: string) => { if (tryAgainAfter(reason)) socket.connect() })
  socket.on('connect_error', (err: unknown) => { if (tryAgainAfterRefusal(err)) setTimeout(() => { socket.connect() }, UNCHECKED_RETRY_MS) })
  return socket
}

const openedShared = (): Socket => {
  const socket = opened()
  let connectedBefore = false
  socket.on('connect', () => {
    if (connectedBefore) for (const listener of reconnectedListeners) listener()
    connectedBefore = true
  })
  return socket
}

export function onReconnected(listener: () => void): () => void {
  reconnectedListeners.add(listener)
  return () => { reconnectedListeners.delete(listener) }
}

export function getSocket(): Socket {
  if (!shared) shared = openedShared()
  return shared
}

export function reconnectSocket(): void {
  const socket = getSocket()
  if (!socket.connected) socket.connect()
}

export function disconnectShared(): void {
  shared?.disconnect()
  shared = null
}

export function useSocketEvent<T = unknown>(
  event: string,
  handler: (payload: T) => unknown,
): void {
  const handlerRef = useRef(handler)
  useEffect(() => { handlerRef.current = handler })

  useEffect(() => {
    const socket = getSocket()
    const listener = (payload: T) => handlerRef.current(payload)
    socket.on(event, listener)
    return () => { socket.off(event, listener) }
  }, [event])
}

export function useLogSocket(opts: {
  room: string | null
  event?: 'log' | 'kube-log'
  onChunk: (chunk: string) => void
  onReconnect?: (() => void) | undefined
  join?: { emit: 'tail-pod'; payload: unknown } | undefined
}): void {
  const { room, event = 'log', join } = opts
  const onChunkRef = useRef(opts.onChunk)
  const onReconnectRef = useRef(opts.onReconnect)
  useEffect(() => {
    onChunkRef.current = opts.onChunk
    onReconnectRef.current = opts.onReconnect
  })

  const joinKey = join ? `${join.emit}:${JSON.stringify(join.payload)}` : ''

  useEffect(() => {
    if (!room) return undefined
    const socket = opened()
    const isKube = Boolean(join)

    const enter = () => {
      socket.emit(isKube ? 'join-kube-room' : 'join-room', room)
      if (join) socket.emit(join.emit, join.payload)
    }

    const reconnected = () => { onReconnectRef.current?.(); enter() }
    socket.on(event, (chunk: string) => onChunkRef.current(chunk))
    socket.io.on('reconnect', reconnected)
    socket.connect()
    enter()

    return () => {
      socket.emit(isKube ? 'leave-kube-room' : 'leave-room', room)
      socket.io.off('reconnect', reconnected)
      socket.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, event, joinKey])
}
