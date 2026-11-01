import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import { bugBacked, SWALLOWING } from '../../eslint.bug-backed.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig([
  globalIgnores(['dist', 'node_modules']),
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-restricted-syntax': ['error', ...SWALLOWING],
    },
  },
  bugBacked({ files: ['src/**/*.ts'], root: ROOT }),
])
