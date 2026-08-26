import { test, expect } from '@playwright/test';

/**
 * E2E: ChatSurface unified persona-pack surface on live dev stack.
 *
 * Runs against the existing dev servers (Vite: 5173, Backend: 3001).
 * Does NOT spawn servers — assumes `npm run dev` is already running.
 *
 * NOTE: Full auth E2E requires a seeded test user (invite-only DB).
 * The 3 smoke tests below verify the unified /api/chat-pack/:packId endpoints
 * are mounted and return 401 (auth required), not 404 (route missing).
 */

const API_BASE = 'http://localhost:3001';

test.describe.configure({ retries: 0 });

test.describe('ChatSurface — unified chat endpoints', () => {
  // ── Smoke: endpoints exist ──────────────────────────────────────────────
  test('chat-pack endpoint exists and returns 401 without auth', async ({ request }) => {
    const response = await request.post(`${API_BASE}/api/chat-pack/koala`, {
      data: { conversationId: 'e2e-test', message: 'hi' },
      headers: { 'Content-Type': 'application/json' },
    });
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

  // TODO: Full auth E2E (register → login → chat → reply) requires a seeded test user
  // in the DB. Current DB is invite-only with no invite codes available.
  // To enable: seed a test user via admin/invite API, then uncomment below.
  //
  // test('register → sign in → send message → see assistant reply', async ({ page }) => { ... })
  // test('login existing user → send message → see reply', async ({ page }) => { ... })
  // test('researcher pack shows thinking pane', async ({ page }) => { ... })
  // test('tool pill appears for a tool call', async ({ page }) => { ... })
});
