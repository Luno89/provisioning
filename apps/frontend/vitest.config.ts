import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { REPORTERS, tiers } from '../../tests/tiers/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      react: path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
    },
  },
  test: {
    reporters: REPORTERS,
    server: {
      deps: {
        inline: [/use-sync-external-store/, /@tanstack/, /@dnd-kit/],
      },
    },
    environment: 'jsdom',
    env: { VITE_API_BASE: 'http://127.0.0.1:9/api' },
    globals: true,
    projects: tiers({
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['./src/test/setup.ts'],
      unit: { setupFiles: ['./src/test/unit-setup.ts'] },
      integration: {
        globalSetup: ['../backend/vitest.global-setup.ts'],
        setupFiles: ['../backend/vitest.setup.ts'],
        env: { VITE_API_BASE: '/api' },
        environment: './src/test/backend/page-environment.ts',
      },
    }),
    testTimeout: 30000,
  },
});
