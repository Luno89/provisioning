import '@testing-library/jest-dom';
import { vi, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

window.HTMLElement.prototype.scrollIntoView = vi.fn();
// jsdom implements neither of these. Chat scrolls its transcript to the bottom on every message,
// so without this the whole component tree dies with "scrollTo is not a function" — which surfaces
// as every query in the test appearing to find nothing.
window.HTMLElement.prototype.scrollTo = vi.fn();
window.Element.prototype.scrollTo = vi.fn();

afterEach(() => {
  cleanup();
});

// Mock Socket.io
vi.mock('socket.io-client', () => {
  return {
    io: vi.fn(() => ({
      on: vi.fn(),
      emit: vi.fn(),
      disconnect: vi.fn(),
      off: vi.fn(),
    })),
  };
});

