import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { renderHook } from '@testing-library/react'
import { Server, type Socket as ServerSocket } from 'socket.io'
import { afterEach, describe, expect, it, vi } from 'vitest'

let http: HttpServer | undefined
let server: Server | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.resetModules()
  await new Promise<void>((done) => { if (server) void server.close(() => done()); else done() })
  http = undefined
  server = undefined
})

interface Heard { joins: string[]; joined: (count: number) => Promise<ServerSocket> }

async function aServer(): Promise<{ url: string; heard: Heard }> {
  http = createServer()
  server = new Server(http, { cors: { origin: true, credentials: true } })
  const joins: string[] = []
  const waiting: Array<{ count: number; done: (socket: ServerSocket) => void }> = []
  server.on('connection', (socket) => {
    socket.on('join-room', (room: string) => {
      joins.push(room)
      void socket.join(room)
      for (const wait of waiting.splice(0)) { if (joins.length >= wait.count) wait.done(socket); else waiting.push(wait) }
    })
  })
  await new Promise<void>((done) => http!.listen(0, '127.0.0.1', () => done()))
  const joined = (count: number) => new Promise<ServerSocket>((done) => waiting.push({ count, done }))
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, heard: { joins, joined } }
}

describe('following a log over the socket', () => {
  it('connects and joins the log\'s room, hears its lines, and when the connection drops joins again and tells the page to reload what it shows', async () => {
    const { url, heard } = await aServer()
    vi.stubEnv('VITE_SOCKET_URL', url)
    const { useLogSocket } = await import('./socket')
    const lines: string[] = []
    let reloaded!: () => void
    const reloading = new Promise<void>((done) => { reloaded = done })
    let said!: () => void
    const heardLine = new Promise<void>((done) => { said = done })

    const hook = renderHook(() => useLogSocket({ room: 'app-1', onChunk: (chunk) => { lines.push(chunk); said() }, onReconnect: () => reloaded() }))
    const first = await heard.joined(1)
    server!.to('app-1').emit('log', 'the first line')
    await heardLine
    first.conn.close()
    await heard.joined(2)
    await reloading
    hook.unmount()

    expect(lines).toEqual(['the first line'])
    expect(heard.joins).toEqual(['app-1', 'app-1'])
  })
})
