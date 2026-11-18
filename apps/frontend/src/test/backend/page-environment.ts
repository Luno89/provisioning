import { builtinEnvironments, type Environment } from 'vitest/runtime'

const jsdom = builtinEnvironments.jsdom

const page: Environment = {
  ...jsdom,
  name: 'page-beside-the-backend',
  viteEnvironment: 'ssr',
  setup: async (global, options) => {
    const window = await jsdom.setup(global, options)
    delete (global as { WebSocket?: unknown }).WebSocket
    return window
  },
}

export default page
