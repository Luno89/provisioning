import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const backend = process.env.KOALA_BACKEND
const toBackend = backend ? { target: backend, changeOrigin: false, xfwd: true } : undefined

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  ...(toBackend ? {
    cacheDir: `node_modules/.vite-${new URL(backend!).port}`,
    server: {
      proxy: {
        '/api': toBackend,
        '/socket.io': { ...toBackend, ws: true },
        '/machine.sh': toBackend,
        '/install.sh': toBackend,
      },
    },
  } : {}),
  resolve: {
    alias: {
      react: path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
    },
  },
})
