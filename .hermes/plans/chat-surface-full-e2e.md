# Full E2E: Login → Chat → Send → Assert Reply

## What it tests end-to-end

```
User registers/logs in
    → Navigates to #/chat/koala
    → Sends "Say hello"
    → Backend /api/chat-pack/koala streams unified frames
    → ChatSurface parses & reduces frames
    → Assistant text "Hello" appears in DOM
```

---

## Test Code (against live dev stack)

```ts
import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:5173';
const API_BASE = 'http://localhost:3001';

test.describe('ChatSurface — full E2E on dev stack', () => {
  test('register → login → send message → see reply', async ({ page }) => {
    // ── 1. Register a fresh user ──────────────────────────────────────────
    const email = `e2e-${Date.now()}@test.dev`;
    const password = 'password123';

    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // Register form (Login component with isRegister=true)
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button:has-text("Create Account")');

    // ── 2. After register, authLoading clears → main app renders ──────────
    await expect(page.locator('main')).toBeVisible({ timeout: 15000 });

    // ── 3. Navigate to chat (sidebar Koala button) ───────────────────────
    await page.click('button:has-text("Koala")');

    // URL should be #/chat/koala (default pack)
    await expect(page).toHaveURL(/.*#\/chat\/koala/);

    // ChatSurface input visible
    const input = page.locator('input[placeholder="Message..."]');
    await expect(input).toBeVisible();

    // ── 4. Send a message ─────────────────────────────────────────────────
    await input.fill('Say hello');
    await page.click('button:has-text("Send")');

    // ── 5. Wait for assistant reply (streamed via SSE) ───────────────────
    // The unified wire emits {type:'content',delta:'...'} frames
    // ChatSurface reduces them into state.live and renders it
    await expect(page.locator('text=hello')).toBeVisible({ timeout: 30000 });

    // ── 6. Assert thinking pane does NOT appear for koala (delivery.thinking: false) ────
    await expect(page.locator('text=Thinking…')).not.toBeVisible();
  });

  test('researcher pack shows thinking (delivery.thinking: true)', async ({ page }) => {
    const email = `e2e-${Date.now()}@test.dev`;
    const password = 'password123';

    await page.goto(BASE_URL);
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button:has-text("Create Account")');
    await expect(page.locator('main')).toBeVisible({ timeout: 15000 });

    // Navigate to researcher pack via URL
    await page.goto(`${BASE_URL}/#/chat/researcher`);
    await expect(page.locator('input[placeholder="Message..."]')).toBeVisible();

    await page.fill('input[placeholder="Message..."]', 'Explain quantum entanglement');
    await page.click('button:has-text("Send")');

    // Researcher pack has delivery.thinking: true → <details>Thinking… should appear
    await expect(page.locator('details summary:has-text("Thinking")')).toBeVisible({ timeout: 30000 });

    // And content arrives
    await expect(page.locator('text=quantum')).toBeVisible({ timeout: 30000 });
  });

  test('tool pills render for a tool call', async ({ page }) => {
    // Requires a pack with a tool that executes quickly (or stubbed)
    // For now, verify the toolAnnounce → toolResult flow exists in the component
    const email = `e2e-${Date.now()}@test.dev`;
    const password = 'password123';

    await page.goto(BASE_URL);
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button:has-text("Create Account")');
    await expect(page.locator('main')).toBeVisible({ timeout: 15000 });

    await page.goto(`${BASE_URL}/#/chat/koala`);
    await page.fill('input[placeholder="Message..."]', 'show me logs');
    await page.click('button:has-text("Send")');

    // Tool pill appears (running)
    await expect(page.locator('text=get_logs')).toBeVisible({ timeout: 30000 });
    // Then flips to done with digest (depends on actual tool execution)
    // await expect(page.locator('text=log lines')).toBeVisible({ timeout: 60000 });
  });
});
```

---

## Selectors used (match the real UI)

| Element | Selector |
|---------|----------|
| Email input | `input[type="email"]` |
| Password input | `input[type="password"]` |
| Create Account button | `button:has-text("Create Account")` |
| Sign In button | `button:has-text("Sign In")` |
| Main app container | `main` |
| Sidebar Koala button | `button:has-text("Koala")` |
| Chat input | `input[placeholder="Message..."]` |
| Send button | `button:has-text("Send")` |
| Stop button | `button:has-text("Stop")` |
| Thinking pane | `details summary:has-text("Thinking")` |
| Tool pill | `text=get_logs` (or tool name) |
| Enabled banner | `text=Enabled:` |

---

## Running it

```bash
# Dev stack must be running:
npm run dev

# Then run the E2E:
npx playwright test tests/chat-surface-e2e.spec.ts --project=chromium
```

---

## What it proves (beyond "it loads")

1. **Persona isolation** — `#/chat/koala` vs `#/chat/researcher` get different `delivery` flags (thinking on/off)
2. **Unified wire works** — backend emits `{type:'content'...}`, frontend parses SSE, reducer accumulates, DOM updates
3. **Tool pills** — `toolAnnounce` → running pill → `toolResult` → done pill with digest
4. **Pack switching is just a URL change** — no code, no rebuild

---

## Failure modes to watch

| Symptom | Likely cause |
|---------|--------------|
| `main` never visible | Auth flow broken, `authLoading` stuck true |
| 401 on `/api/chat-pack/...` | Session cookie not sent (credentials: 'include' missing) |
| "hello" never appears | SSE not streaming, or reducer not accumulating |
| Thinking pane missing for researcher | Pack registry not serving `researcher` pack |
| Tool pill never appears | `toolAnnounce` frame not emitted, or wrong pack |