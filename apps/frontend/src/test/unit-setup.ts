import { vi } from 'vitest';

vi.mock('socket.io-client', () => {
  return {
    io: vi.fn(() => ({
      connected: true,
      connect: vi.fn(),
      on: vi.fn(),
      emit: vi.fn(),
      disconnect: vi.fn(),
      off: vi.fn(),
      io: { on: vi.fn(), off: vi.fn() },
    })),
  };
});
