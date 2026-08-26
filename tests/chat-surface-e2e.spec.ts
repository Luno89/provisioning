import { test, expect } from '@playwright/test';

/**
 * E2E: ChatSurface unified persona-pack surface on live dev stack.
 *
 * Runs against the existing dev servers (Vite: 5173, Backend: 3001).
 * Does NOT spawn servers — assumes `npm run dev` is already running.
 */

const BASE_URL = 'http://localhost:5173';
const API_BASE = 'http://localhost:3001';

test.describe.configure({ retries: 0 });

test.describe('ChatSurface — unified chat on dev stack', () => {
  test('chat-pack endpoint exists and returns 401 without auth', async ({ request }) => {
    // The unified /api/chat-pack/:packId route should exist (mounted in backend)
    const response = await request.post(`${API_BASE}/api/chat-pack/koala`, {
      data: { conversationId: 'e2e-test', message: 'hi' },
      headers: { 'Content-Type': 'application/json' },
    });
    // 401 = route exists, auth required; 404 = route missing
    expect(response.status()).toBe(401);
  });

  test('researcher pack endpoint also exists', async ({ request }) => {
    const response = await request.post(`${API_BASE}/api/chat-pack/researcher`, {
      data: { conversationId: 'e2e-test', message: 'hi' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status()).toBe(401);
  });

  test('harness pack endpoint also exists', async ({ request }) => {
    const response = await request.post(`${API_BASE}/api/chat-pack/harness`, {
      data: { conversationId: 'e2e-test', message: 'hi' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status()).toBe(401);
  });
});