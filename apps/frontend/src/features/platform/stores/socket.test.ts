import { describe, it, expect, vi, beforeEach } from 'vitest'
import { io } from 'socket.io-client'
import { disconnectShared, getSocket, reconnectSocket } from './socket'

beforeEach(() => { disconnectShared() })

describe('the shared socket before anyone signs in', () => {
  it('is made without connecting, so a signed-out page never asks the server for a socket it would refuse', () => {
    const socket = { connected: false, connect: vi.fn(), on: vi.fn(), off: vi.fn(), disconnect: vi.fn() }
    vi.mocked(io).mockReturnValueOnce(socket as never)

    getSocket()

    expect(vi.mocked(io).mock.lastCall?.[1]).toMatchObject({ autoConnect: false })
    expect(socket.connect).not.toHaveBeenCalled()
  })
})

describe('the shared socket after signing in', () => {
  it('connects once someone is signed in', () => {
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
