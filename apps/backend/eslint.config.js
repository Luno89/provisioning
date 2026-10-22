import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

const LAYERS = [
  { files: ['src/lib/**/*.ts'], above: ['services', 'routes', 'wiring', 'middleware', 'activities', 'workflows', 'engine-host', 'extensions'], message: 'lib is pure: it imports nothing above it' },
  { files: ['src/services/**/*.ts'], above: ['routes', 'wiring', 'middleware'], message: 'a service never imports a route, the wiring or middleware' },
  { files: ['src/routes/**/*.ts'], above: ['wiring'], message: 'a route takes its deps from the wiring, never imports it' },
]

const upward = (folders) => folders.flatMap((folder) => [`**/${folder}/*`, `**/${folder}/**`, `../${folder}`, `../../${folder}`])

export default defineConfig([
  globalIgnores(['dist', 'data', 'node_modules']),
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
    },
  },
  ...LAYERS.map((layer) => ({
    files: layer.files,
    ignores: ['**/*.test.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: upward(layer.above), message: layer.message }] }],
    },
  })),
])
