import '@testing-library/jest-dom';
import { vi, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.scrollTo = vi.fn();
window.Element.prototype.scrollTo = vi.fn();

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver);

afterEach(() => {
  cleanup();
});
