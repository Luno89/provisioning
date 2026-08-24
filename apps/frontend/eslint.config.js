import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

/**
 * ── THE RATCHET ──
 *
 * This config was the stock Vite scaffold, wired to no root script and run by no CI, and it had
 * been red for a long time: 171 problems across 35 files. A lint nobody runs is not a rule, which
 * is a large part of how App.tsx reached 2,858 lines.
 *
 * It is green from here on, and it stays green, via a mechanism chosen over the two obvious ones:
 *
 *   · NOT a generated baseline file. A hash-keyed baseline suppresses by fingerprint, so it will
 *     silently re-suppress a NEW violation that happens to look like an old one, and it tells a
 *     reader nothing about which files are actually in debt.
 *   · NOT rules-off globally, which is how you get a config that permits everything forever.
 *
 * Instead: an explicit, named list of the files that carry debt today, in `LEGACY` below. Every
 * file NOT on that list is fully checked, and every file written from now on is clean by default.
 *
 * **The list only ever shrinks.** Each refactor slice deletes the files it rewrites, so the length
 * of `LEGACY` is the progress bar — and a diff that ADDS to it is asking for a conversation.
 *
 * Debt at the time of writing: 165 problems, 57 of them in App.tsx and 26 more across
 * CloudAccounts, NginxView and ClustersView — all four of which the slices rewrite. The six that
 * were not `any` (3 `no-control-regex` in AnsiText, where matching ESC is the entire job of an ANSI
 * parser, and 3 unused catch bindings) were fixed outright rather than listed.
 */
const LEGACY = [
  // Retired from the free list only after a source fix — each of these has exactly one real
  // violation, and the fix waits for the E2E run in flight (a vite HMR reload mid-test would
  // restart the page under Playwright).
  'src/components/AcceptanceEditor.tsx',
  'src/components/Lab/index.tsx',
  'src/lib/proposal-display.ts',
  // Slice 4 (the App.tsx modal extraction) retires this one; it is a third of all debt.
  'src/App.tsx',
  // Slice 3.
  'src/components/NginxView.tsx',
  'src/components/ClusterWizard.tsx',
  // Slice 5 (Grove) and slice 6 (Lab) — mostly `any` on records that want a real shared type.
  'src/components/Grove.tsx',
  'src/components/Chat.tsx',
  'src/components/KoalaChat.tsx',
  'src/components/LeafDetail.tsx',
  'src/components/Home.tsx',
  'src/components/PersonaEditor.tsx',
  'src/components/Projects.tsx',
  'src/components/Lab/ToolRepoPanel.tsx',
  'src/components/Lab/Harness.tsx',
  'src/components/Lab/MemoryBankPanel.tsx',
  // Not yet assigned to a slice: small, and each wants a domain type that does not exist yet.
  'src/TemporalPanel.tsx',
  'src/ServicesPanel.tsx',
  'src/components/MeshDevices.tsx',
  'src/components/VpsCatalog.tsx',
  'src/components/Login.tsx',
]

/**
 * Tests get one exemption and no others: `any` in a fixture is usually a deliberately partial
 * record standing in for a shape the test does not care about, and forcing it to be complete makes
 * the test assert things it is not about.
 */
const LEGACY_TESTS = ['**/*.test.ts', '**/*.test.tsx']

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      /**
       * `const { [key]: _dropped, ...rest } = obj` is the idiomatic way to remove one key without
       * mutating, and the discarded binding is the point of it. `ignoreRestSiblings` is exactly
       * that case; the `^_` patterns make "I know, and I meant it" sayable everywhere else.
       */
      '@typescript-eslint/no-unused-vars': ['error', {
        ignoreRestSiblings: true,
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: LEGACY,
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // Real bugs in waiting, but they are the shape of the code being replaced. Warn so they stay
      // visible, and so the slice that rewrites the file has a list to work from.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-refresh/only-export-components': 'warn',
    },
  },
  {
    files: LEGACY_TESTS,
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
])
