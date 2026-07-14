"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const test_1 = require("@playwright/test");
exports.default = (0, test_1.defineConfig)({
    testDir: './tests',
    fullyParallel: false,
    forbidOnly: false,
    retries: 0,
    workers: 1, // Sequential execution as it provisions/deprovisions clusters
    reporter: 'line',
    use: {
        baseURL: 'http://localhost:5174',
        trace: 'off',
        screenshot: 'only-on-failure',
        video: 'off',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...test_1.devices['Desktop Chrome'] },
        },
    ],
    webServer: [
        {
            command: 'PORT=3002 IS_E2E=true NODE_ENV=test npx concurrently --kill-others "npm run dev -w apps/backend" "npm run dev:worker -w apps/backend" "npm run dev:worker:cluster -w apps/backend" > backend.log 2>&1',
            port: 3002,
            reuseExistingServer: true,
        },
        {
            command: 'VITE_IS_E2E=true VITE_API_BASE=http://localhost:3002/api VITE_SOCKET_URL=http://localhost:3002 npm run dev -w apps/frontend -- --port 5174',
            port: 5174,
            reuseExistingServer: true,
        }
    ],
});
//# sourceMappingURL=playwright.config.js.map