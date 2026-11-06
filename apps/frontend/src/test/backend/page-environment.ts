import { builtinEnvironments, type Environment } from 'vitest/runtime'

const page: Environment = { ...builtinEnvironments.jsdom, name: 'page-beside-the-backend', viteEnvironment: 'ssr' }

export default page
