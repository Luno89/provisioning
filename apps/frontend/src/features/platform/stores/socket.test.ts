import { describe, it, expect, vi, beforeEach } from 'vitest'
import { io } from 'socket.io-client'
import { disconnectShared, reconnectSocket } from './socket'

beforeEach(() => { disconnectShared() })

describe('the shared socket after signing in', () => {
  it('connects again when the server turned it away before there was a session', () => {
    const socket = { connected: false, connect: vi.fn(), on: vi.fn(), off: vi.fn(), disconnect: vi.fn() }
    vi.mocked(io).mockReturnValueOnce(socket as never)

    reconnectSocket()

    expect(socket.connect).toHaveBeenCalledTimes(1)
  })

  it('leaves a live connection alone', () => {
    const socket = { connected: true, connect: vi.fn(), on: vi.fn(), off: vi.fn(), disconnect: vi.fn() }
    vi.mocked(io).mockReturnValueOnce(socket as never)

    reconnectSocket()

    expect(socket.connect).not.toHaveBeenCalled()
  })
})
