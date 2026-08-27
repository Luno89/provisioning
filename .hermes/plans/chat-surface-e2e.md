# E2E Test Plan: Unified ChatSurface on Live Dev Stack

## Goal
Verify the **ChatSurface** component works end-to-end against the running dev stack (`npm run dev`):
- Auth → Chat page → Send message → Stream unified frames → Render correctly
- Multiple persona packs (koala, researcher, harness) serve their own system prompts
- Tool calls, thinking, enabled services all render from unified wire

---

## Test Stack
- **Playwright** (headless Chrome) — already in `package.json` devDeps
- Target: `http://localhost:5173` (Vite) + `http://localhost:3001` (backend)
- Auth: Register → Login → JWT cookie → session persists

---

## Test Scenarios (ordered by risk)

### 1. Smoke: Koala pack renders a reply
- Register/Login
- Navigate to `/chat/koala` (or wherever ChatSurface is mounted)
- Send "Say hello"
- Assert: assistant text appears, no console errors

### 2. Persona isolation: Researcher pack gets Researcher system prompt
- Same flow, packId=`researcher`
- Intercept the upstream request (Playwright route mock) → assert `messages[0].content` contains "rigorous Researcher", NOT "Koala"

### 3. Tool pills: toolAnnounce → toolResult renders live
- Pack with a stubbed MCP tool (or koala's `get_logs`)
- Send "show me logs"
- Assert: pill appears "get_logs" (running), then flips to done + digest

### 4. Thinking pane: reasoning_content streams
- Pack with thinking enabled (`delivery.thinking: true`)
- Send a reasoning-heavy prompt
- Assert: `<details>Thinking…` opens with streaming reasoning text

### 5. Enabled services banner
- Pack with `enabled: ['github-mcp']` (or stubbed)
- Assert banner shows "github-mcp"

### 6. Harness pack (workbench) still works
- Pack `harness` with `delivery.plan: true, usage: true`
- Assert plan/usage frames render (or are suppressed per delivery)

---

## Page Object / Helpers

```ts
// tests/e2e/chat-helpers.ts
export async function login(page, email, password) { ... }
export async function openChat(page, packId) { ... }
export async function sendMessage(page, text) { ... }
export async function waitForReply(page) { ... }
export function getLiveText(page) { ... }
export function getThinking(page) { ... }
export function getToolPills(page) { ... }
```

---

## CI Integration
- Runs on `main` after unit suites pass
- Spins up `npm run dev` (or `docker compose up`) in background
- Playwright runs against it
- Artifacts: trace.zip, screenshots on failure

---

## Dependencies to Resolve First
1. **Mount ChatSurface in the app** — find where `Chat` and `KoalaChat` are rendered, swap to `ChatSurface` with the right `packId` prop
2. **Route for `/chat/:packId`** — add a page/component that renders `<ChatSurface packId={params.packId} />`
3. **Auth in test** — either register a fresh user per test, or seed a test user in `beforeAll`

---

## First Slice to Implement
**Minimal E2E (1 test):**
```ts
test('koala pack streams a reply', async ({ page }) => {
  await login(page, 'test@e2e.dev', 'password');
  await page.goto('/chat/koala');
  await sendMessage(page, 'Say hello');
  await expect(page.locator('[data-testid="assistant-message"]')).toContainText('hello');
});
```

This verifies the full stack: Vite → ChatSurface → `/api/chat-pack/koala` → backend engine → unified frames → reducer → render.

---

## Rollback Safety
- Old `Chat` + `KoalaChat` components remain in repo until E2E passes
- Feature flag or route switch can toggle back instantly