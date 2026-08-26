import { test, expect } from '@playwright/test';

/**
 * E2E: ChatSurface unified persona-pack surface on live dev stack.
 *
 * Runs against the existing dev servers (Vite: 5173, Backend: 3001).
 * Does NOT spawn servers — assumes `npm run dev` is already running.
 *
 * Requires a seeded test user (run: npx tsx scripts/seed-e2e-user.ts)
 * User: e2e-test@test.dev / password123
 * Invite: e2e-test-invite-1234
 *
 * NOTE: Full model-backed chat requires a vLLM/TabbyAPI deployment.
 * Current dev stack returns "No models available" (404) — expected.
 * The unified /api/chat-pack/:packId route IS functional.
 */

const BASE_URL = 'http://localhost:5173';
const API_BASE = 'http://localhost:3001';

test.describe.configure({ retries: 0 });

test.describe('ChatSurface — unified chat on dev stack', () => {
  // Smoke: endpoints exist and require auth
  test('chat-pack endpoint exists and returns 401 without auth', async ({ request }) => {
    const response = await request.post(API_BASE + '/api/chat-pack/koala', {
      data: { conversationId: 'e2e-test', message: 'hi' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status()).toBe(401);
  });

  test('researcher pack endpoint also exists', async ({ request }) => {
    const response = await request.post(API_BASE + '/api/chat-pack/researcher', {
      data: { conversationId: 'e2e-test', message: 'hi' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status()).toBe(401);
  });

  test('harness pack endpoint also exists', async ({ request }) => {
    const response = await request.post(API_BASE + '/api/chat-pack/harness', {
      data: { conversationId: 'e2e-test', message: 'hi' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status()).toBe(401);
  });

  // Auth works: login with seeded user
  const TEST_EMAIL = 'e2e-test@test.dev';
  const TEST_PASSWORD = 'password123';

  async function login(page: import('@playwright/test').Page) {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', TEST_PASSWORD);
    await page.click('button:has-text("Sign In")');
    await expect(page.locator('input[placeholder="Message..."]')).toBeVisible({ timeout: 30000 });
  }

  test('login with seeded user works', async ({ page }) => {
    await login(page);
    // Main app loads -> chat input visible
    await expect(page.locator('input[placeholder="Message..."]')).toBeVisible();
  });

  test('authenticated request to chat-pack returns model-not-available (not 401/404)', async ({ page, request }) => {
    await login(page);

    // Get the session cookie from the browser
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find(c => c.name === 'session');
    expect(sessionCookie).toBeTruthy();

    // Make authenticated request
    const response = await request.post(API_BASE + '/api/chat-pack/koala', {
      data: { conversationId: 'e2e-test', message: 'hi' },
      headers: { 'Content-Type': 'application/json', 'Cookie': 'session=' + sessionCookie!.value },
    });

    // Should be 404 (model not deployed), NOT 401 (unauthorized) or 404 (route missing)
    // 404 with "No models available" = route exists, auth works, model missing
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body.error).toContain('No models available');
  });

  // Full model-backed E2E requires vLLM/TabbyAPI deployment
  // TODO: When model infra is running, uncomment:
  //
  // test('researcher pack shows thinking pane (delivery.thinking: true)', async ({ page }) => { ... })
  // test('tool pill appears for a tool call', async ({ page }) => { ... })
  // test('login -> send message -> see assistant reply', async ({ page }) => { ... })
});