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
        /**
         * Traces on failure, which used to be 'off'.
         *
         * A run that fails here costs 15 minutes and a real k3d cluster, and with tracing off the
         * only artefact is a screenshot: the WordPress deploy failed with the wizard sitting on a
         * correctly-filled confirm step, and nothing recorded whether the POST was even sent, let
         * alone what came back. Answering that took a hand-written Playwright script with a
         * request interceptor — for a question the trace viewer answers by default.
         *
         * 'retain-on-failure' rather than 'on': a passing 15-minute run would otherwise write
         * hundreds of megabytes of trace nobody reads.
         */
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'off',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...test_1.devices['Desktop Chrome'] },
        },
    ],
    // The E2E worker pair binds its own Prometheus ports.
    //
    // Both workers export metrics — 9465 for host, 9464 for cluster, and worker-host.ts's own
    // comment explains why they differ ("same port would collide"). What it did not account for is
    // a SECOND pair: `npm run test:e2e` runs `test:alive` first, which REQUIRES the dev workers to
    // be running, and then Playwright starts its own pair here. Those hit the ports the dev pair
    // already holds and die with "Failed to start prometheus metrics exporter: Address already in
    // use", which surfaces only as "Process from config.webServer was not able to start".
    //
    // So the two requirements were in direct conflict and e2e could not pass either way.
    /**
     * `stdout: 'pipe'` on both, because it defaulted to 'ignore'.
     *
     * The E2E run log contained ZERO lines of backend output. When a route rejects a request the
     * reason is in that output and nowhere else, so a failed deploy was undiagnosable from the
     * artefacts alone. Piping it costs noise on a passing run and answers the question on a
     * failing one.
     */
    webServer: [
        {
            command: 'PORT=3002 IS_E2E=true NODE_ENV=test npx concurrently --kill-others "npm run dev -w apps/backend" "TEMPORAL_METRICS_PORT=9467 npm run dev:worker -w apps/backend" "TEMPORAL_METRICS_PORT=9466 npm run dev:worker:cluster -w apps/backend" > backend.log 2>&1',
            port: 3002,
            reuseExistingServer: true,
            stdout: 'pipe',
            stderr: 'pipe',
        },
        {
            command: 'VITE_IS_E2E=true VITE_API_BASE=http://localhost:3002/api VITE_SOCKET_URL=http://localhost:3002 npm run dev -w apps/frontend -- --port 5174',
            port: 5174,
            reuseExistingServer: true,
            stdout: 'pipe',
            stderr: 'pipe',
        }
    ],
});
//# sourceMappingURL=playwright.config.js.map