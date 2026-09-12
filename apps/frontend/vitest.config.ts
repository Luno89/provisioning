import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

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
    server: {
      deps: {
        inline: [/use-sync-external-store/, /@tanstack/, /@dnd-kit/],
      },
    },
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    testTimeout: 30000,
  },
});
