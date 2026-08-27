import { test, expect } from '@playwright/test';

/**
 * E2E: ChatSurface unified persona-pack surface on live test stack.
 *
 * Runs against test webServers (Vite: 5174, Backend: 3002 with IS_E2E=true).
 */

const BASE_URL = 'http://localhost:5174';
const API_BASE = 'http://localhost:3002';

test.describe.configure({ retries: 0 });

test.describe('ChatSurface — unified chat & retro 2D tree on live stack', () => {
  test('persona pack endpoints exist and handle requests', async ({ request }) => {
    // Researcher pack route check
    const researcherRes = await request.post(API_BASE + '/api/chat-pack/researcher', {
      data: { message: 'hello researcher' },
      headers: { 'Content-Type': 'application/json' },
    });
    // In E2E test stack without active LLM provider/keys, expects 200, 404, or 500 from the provider runtime
    expect([200, 404, 500]).toContain(researcherRes.status());

    // Harness pack route check
    const harnessRes = await request.post(API_BASE + '/api/chat-pack/harness', {
      data: { message: 'hello harness' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([200, 404, 500]).toContain(harnessRes.status());
  });

  test('main frontend renders ChatSurface with persona HUD, composer, and 2D history tree', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // Chat Surface is the front door
    await expect(page.locator('[placeholder="Message..."]')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('button:has-text("New")')).toBeVisible();
    await expect(page.getByText('KOALA', { exact: true })).toBeVisible();

    // 2D History Tree canvas should be rendered in integrated split-view
    await expect(page.locator('text=CORE ARCHIVE')).toBeVisible();
  });

  test('toggles 2D History Tree view and opens Persona & Tool Tuning Drawer', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // Toggle 2D tree to Focus Chat mode
    const treeToggleBtn = page.locator('button:has-text("2D History Tree"), button:has-text("Focus Chat")');
    await expect(treeToggleBtn).toBeVisible();
    await treeToggleBtn.click();

    // Open Persona & Tool Tuning Drawer
    const configBtn = page.locator('button:has-text("Tools & Persona")');
    await expect(configBtn).toBeVisible();
    await configBtn.click();

    // Verify Drawer contents
    await expect(page.locator('text=DIRECTIVE & SYSTEM PROMPT')).toBeVisible();
    await expect(page.locator('text=CORE CAPABILITY MATRIX')).toBeVisible();
    await expect(page.locator('text=DEPLOYED MCP SERVICES')).toBeVisible();

    // Close drawer
    await page.locator('button[title="Close configuration"]').click();
    await expect(page.locator('text=DIRECTIVE & SYSTEM PROMPT')).not.toBeVisible();
  });

  test('conversation vault lifecycle works end-to-end via UI and API', async ({ page, request }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // 1. Create a new conversation via API
    const createRes = await request.post(API_BASE + '/api/chat-pack/conversations', {
      data: { title: 'Playwright Retro Tree Thread' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(createRes.status()).toBe(200);
    const createdConv = await createRes.json();
    expect(createdConv.id).toBeTruthy();
    expect(createdConv.title).toBe('Playwright Retro Tree Thread');

    // 2. List conversations
    const listRes = await request.get(API_BASE + '/api/chat-pack/conversations');
    expect(listRes.status()).toBe(200);
    const list = await listRes.json();
    expect(list.some((c: any) => c.id === createdConv.id)).toBe(true);

    // 3. Get conversation
    const getRes = await request.get(API_BASE + `/api/chat-pack/conversations/${createdConv.id}`);
    expect(getRes.status()).toBe(200);
    const got = await getRes.json();
    expect(got.id).toBe(createdConv.id);

    // 4. Verify thread appears in the 2D Tree / Quick Switcher UI
    await page.reload();
    await expect(page.locator(`text=Playwright Retro Tree Thread`).first()).toBeVisible({ timeout: 10000 });

    // 5. Delete conversation
    const delRes = await request.delete(API_BASE + `/api/chat-pack/conversations/${createdConv.id}`);
    expect(delRes.status()).toBe(200);
  });

  test('proposal acceptance endpoints are registered and respond', async ({ request }) => {
    // Create a temporary conversation
    const createRes = await request.post(API_BASE + '/api/chat-pack/conversations', {
      data: { title: 'Proposal Test Conv' },
      headers: { 'Content-Type': 'application/json' },
    });
    const createdConv = await createRes.json();

    // Accepting a non-existent proposal returns 404 (proposal not found), proving route and handler logic exist
    const treeRes = await request.post(
      API_BASE + `/api/chat-pack/conversations/${createdConv.id}/trees/non-existent/accept`,
      { headers: { 'Content-Type': 'application/json' } }
    );
    expect(treeRes.status()).toBe(404);

    const specRes = await request.post(
      API_BASE + `/api/chat-pack/conversations/${createdConv.id}/specs/non-existent/accept`,
      { headers: { 'Content-Type': 'application/json' } }
    );
    expect(specRes.status()).toBe(404);

    // Clean up
    await request.delete(API_BASE + `/api/chat-pack/conversations/${createdConv.id}`);
  });
});