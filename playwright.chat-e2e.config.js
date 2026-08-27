const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: 'chat-surface-e2e.spec.ts',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://localhost:5174',
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
  webServer: [
    {
      command: 'PORT=3002 IS_E2E=true USE_MEMORY_DB=true NODE_ENV=test npm run dev -w apps/backend',
      port: 3002,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60000,
    },
    {
      command: 'VITE_IS_E2E=true VITE_API_BASE=http://localhost:3002/api VITE_SOCKET_URL=http://localhost:3002 npm run dev -w apps/frontend -- --port 5174',
      port: 5174,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60000,
    }
  ],
});