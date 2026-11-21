import { builtinEnvironments, type Environment } from 'vitest/runtime'

const jsdom = builtinEnvironments.jsdom

const BINARY = ['ArrayBuffer', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Uint8ClampedArray', 'Int8Array', 'Int16Array', 'Int32Array', 'Float32Array', 'Float64Array'] as const

const page: Environment = {
  ...jsdom,
  name: 'page-beside-the-backend',
  viteEnvironment: 'ssr',
  setup: async (global, options) => {
    const node = Object.fromEntries(BINARY.map((name) => [name, (global as Record<string, unknown>)[name]]))
    const window = await jsdom.setup(global, options)
    delete (global as { WebSocket?: unknown }).WebSocket
    Object.assign(global, node)
    return window
  },
}

export default page
