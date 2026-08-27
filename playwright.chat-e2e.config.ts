import { defineConfig } from '@playwright/test';

/**
 * Lightweight Playwright config for ChatSurface E2E against EXISTING dev stack.
 * No server spawning — assumes `npm run dev` is running on 5173/3001.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: 'chat-surface-e2e.spec.ts',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // NO webServer — use existing dev stack
});