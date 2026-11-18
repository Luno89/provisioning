import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { REPORTERS, tiers } from '../../tests/tiers/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE = `${path.resolve(__dirname, 'src')}${path.sep}`;
const BROWSER_SOCKET = path.resolve(__dirname, '../../node_modules/socket.io-client/dist/socket.io.esm.min.js');

const thePageSocketsAsABrowserDoes: Plugin = {
  name: 'the-page-sockets-as-a-browser-does',
  enforce: 'pre',
  resolveId: (id, importer) => (id === 'socket.io-client' && importer?.startsWith(PAGE) ? BROWSER_SOCKET : undefined),
};

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
        inline: [/use-sync-external-store/, /@tanstack/, /@dnd-kit/, /socket\.io-client\/dist\//],
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
        env: { VITE_API_BASE: '/api', VITE_SOCKET_URL: '/' },
        environment: './src/test/backend/page-environment.ts',
        plugins: [thePageSocketsAsABrowserDoes],
      },
    }),
    testTimeout: 30000,
  },
});
