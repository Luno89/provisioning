import { useEffect, useRef } from 'react'
import { io, type Socket } from 'socket.io-client'
import { SOCKET_URL } from '../api/client'

/**
 * The application's socket connection.
 *
 * ── WHAT THIS REPLACES ──
 * Three independent `io()` calls — `App.tsx`, `components/Lab/index.tsx` and
 * `components/Projects.tsx` — each opening its own connection, each with its own handshake and
 * server-side session, and each calling `socket.disconnect()` on unmount. Mounting the Lab while a
 * project was open meant three live sockets for one user, and the `SOCKET_URL` they connected to
 * was declared in three places.
 *
 * ── WHY THERE IS STILL MORE THAN ONE SOCKET, AND WHY THAT IS CORRECT ──
 * The obvious version of this — one connection for everything — introduces a bug. The server routes
 * log output purely by room membership:
 *
 *     io.to(resourceId).emit('log', data)          // InfrastructureService.ts:579
 *     io.to(room).emit('kube-log', data.toString()) // InfrastructureService.ts:376
 *
 * The payload carries no room identifier. With separate connections that is fine: a socket only
 * receives what it joined. With ONE connection joined to two rooms, every `log` handler on that
 * connection receives both streams — so a pipeline log open in Projects would interleave into the
 * cluster log open in App, and neither could tell which lines were theirs.
 *
 * Fixing that properly means adding the room to 22 emit sites across five services, which belongs
 * with the slices that touch those services. So instead:
 *
 *   · ONE shared connection for broadcast events (`resource-destroyed`, `deployment-updated`, the
 *     experiment events). These are not room-routed, so sharing them is safe and is where the
 *     duplication actually was.
 *   · A SEPARATE short-lived connection per log consumer, opened only while a log is on screen and
 *     closed when it leaves. It joins exactly one room, so it can only receive that room's output.
 *
 * Net: one persistent connection instead of three, plus a transient one per open log view. When the
 * emit sites learn to name their room, `useLogSocket` collapses into `useSocketEvent` and this note
 * goes with it.
 */

let shared: Socket | null = null

/**
 * The shared connection, created on first use.
 *
 * `withCredentials` sends the session cookie with the handshake — the server authenticates sockets
 * the same way it authenticates `/api` requests, and in dev the UI is a different origin to the
 * API, so without this the connection is rejected outright.
 *
 * Never disconnected on component unmount. A component going away is not a reason to drop a
 * connection other components are using, and reconnecting costs a handshake and an auth check.
 * `disconnectShared()` exists for logout.
 */
export function getSocket(): Socket {
  if (!shared) shared = io(SOCKET_URL, { withCredentials: true })
  return shared
}

/** Drops the shared connection. For logout, and for tests that need a clean slate. */
export function disconnectShared(): void {
  shared?.disconnect()
  shared = null
}

/**
 * Subscribes to a broadcast event for as long as the component is mounted.
 *
 * The handler is stored in a ref rather than being a dependency, so a component can pass an inline
 * arrow without re-subscribing on every render — the mistake that leaves two handlers attached and
 * makes every event fire twice.
 */
export function useSocketEvent<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): void {
  /**
   * The handler lives in a ref so the subscription is set up ONCE per event name.
   *
   * Passing `handler` as a dependency instead would re-subscribe on every render — callers pass
   * inline arrows, which are a new function each time — and a missed `off` leaves two listeners
   * attached, so every event fires twice. Reading through a ref means the newest handler runs
   * without the subscription ever being torn down.
   */
  const handlerRef = useRef(handler)
  useEffect(() => { handlerRef.current = handler })

  useEffect(() => {
    const socket = getSocket()
    const listener = (payload: T) => handlerRef.current(payload)
    socket.on(event, listener)
    return () => { socket.off(event, listener) }
  }, [event])
}

/**
 * A dedicated connection for one log room, alive only while `room` is set.
 *
 * Separate from the shared socket for the reason in this file's header: log payloads carry no room
 * id, so a connection joined to two rooms cannot tell their output apart. One room per connection
 * makes that unambiguous by construction.
 *
 * `onReconnect` fires before the rejoin so a caller can clear what it has buffered — the server
 * always restarts a tail from scratch rather than resuming, so without that clear the replayed
 * history lands on top of what is already on screen and shows as the same lines repeating. Every
 * backend restart or network blip takes this path.
 */
export function useLogSocket(opts: {
  room: string | null
  event?: 'log' | 'kube-log'
  onChunk: (chunk: string) => void
  onReconnect?: (() => void) | undefined
  /** Emitted after joining — used by the pod tail, which must say which pod it wants. */
  join?: { emit: string; payload: unknown } | undefined
}): void {
  const { room, event = 'log', join } = opts
  const onChunkRef = useRef(opts.onChunk)
  const onReconnectRef = useRef(opts.onReconnect)
  useEffect(() => {
    onChunkRef.current = opts.onChunk
    onReconnectRef.current = opts.onReconnect
  })

  // Serialised so a caller can pass an inline object without re-connecting every render.
  const joinKey = join ? `${join.emit}:${JSON.stringify(join.payload)}` : ''

  useEffect(() => {
    if (!room) return undefined
    const socket = io(SOCKET_URL, { withCredentials: true })
    const isKube = Boolean(join)

    const enter = () => {
      socket.emit(isKube ? 'join-kube-room' : 'join-room', room)
      if (join) socket.emit(join.emit, join.payload)
    }

    socket.on(event, (chunk: string) => onChunkRef.current(chunk))
    socket.on('reconnect', () => { onReconnectRef.current?.(); enter() })
    enter()

    return () => {
      socket.emit(isKube ? 'leave-kube-room' : 'leave-room', room)
      socket.disconnect()
    }
    // `join` is covered by joinKey; including the object would reconnect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, event, joinKey])
}
