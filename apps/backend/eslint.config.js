import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src')

const LAYERS = [
  { files: ['src/*/lib/**/*.ts'], above: ['services', 'routes', 'wiring', 'middleware', 'activities', 'workflows', 'engine-host', 'extensions'], message: 'lib is pure: it imports nothing above it' },
  { files: ['src/*/services/**/*.ts'], above: ['routes', 'wiring', 'middleware'], message: 'a service never imports a route, the wiring or middleware' },
  { files: ['src/*/routes/**/*.ts'], above: ['wiring'], message: 'a route takes its deps from the wiring, never imports it' },
]

const upward = (folders) => folders.flatMap((folder) => [`**/${folder}/*`, `**/${folder}/**`, `../${folder}`, `../../${folder}`])

const AREAS = ['platform', 'accounts', 'instances', 'hub', 'projects', 'releases', 'files', 'machines', 'monitoring', 'models', 'memory', 'checks', 'infrastructure', 'engine']

const WITH_INDEX = ['platform', 'infrastructure', 'projects', 'engine', 'releases', 'hub', 'files', 'machines', 'monitoring', 'models']

const BELOW_SERVICES = ['workflows', 'engine-host', 'extensions', 'eval']

const DIRECT_TO_STAY_ACYCLIC = [
  ['hub/wiring/hub.ts', 'engine/routes/engine.ts'],
  ['index.ts', 'infrastructure/services/TemporalBridge.ts'],
  ['instances/services/IdentityService.ts', 'hub/lib/hub.ts'],
  ['models/routes/models.ts', 'infrastructure/lib/huggingface.ts'],
  ['models/services/ModelService.ts', 'checks/lib/check-space.ts'],
  ['projects/services/ProjectChannelService.ts', 'engine/lib/conversations.ts'],
  ['projects/services/ProjectSharingService.ts', 'hub/lib/hub-sync.ts'],
  ['worker-engine.ts', 'releases/services/CustomizationsService.ts'],
].map(([from, to]) => `${from} -> ${to}`)

const placeOf = (file) => {
  const rel = path.relative(SRC, file).split(path.sep)
  if (rel.length === 1) return { kind: 'root', rel: rel[0] }
  if (AREAS.includes(rel[0])) return { kind: 'area', name: rel[0], rest: rel.slice(1).join('/'), rel: rel.join('/') }
  return { kind: 'place', name: rel[0], rel: rel.join('/') }
}

const pure = (from) => (from.kind === 'area' && (from.rest.startsWith('lib/') || from.rest === 'store.ts')) || (from.kind === 'place' && from.name === 'workflows')

const belowServices = (from) => pure(from) || (from.kind === 'place' && BELOW_SERVICES.includes(from.name))

const boundaries = {
  rules: {
    areas: {
      meta: { type: 'problem', schema: [] },
      create(context) {
        const from = placeOf(context.filename)
        const check = (node, source, typeOnly) => {
          if (typeof source !== 'string' || !source.startsWith('.')) return
          const to = placeOf(path.resolve(path.dirname(context.filename), source).replace(/\.js$/, '.ts'))
          if (to.kind !== 'area' || !WITH_INDEX.includes(to.name) || (from.kind === 'area' && from.name === to.name)) return
          if (to.rest === 'index.ts') {
            if (pure(from) && !typeOnly) context.report({ node, message: `${from.rel} is pure: it takes values from ${to.name}/lib directly and only types from its index, which loads the whole area` })
            return
          }
          if (!typeOnly && belowServices(from) && to.rest.startsWith('lib/')) return
          if (!typeOnly && from.kind === 'root' && to.rest.startsWith('wiring/')) return
          if (!typeOnly && from.rel === 'platform/lib/mongo-db.ts' && to.rest === 'store.ts') return
          if (DIRECT_TO_STAY_ACYCLIC.includes(`${from.rel} -> ${to.rel}`)) return
          context.report({ node, message: `import ${to.name} through its index, never ${to.rest}` })
        }
        return {
          ImportDeclaration: (node) => check(node, node.source.value, node.importKind === 'type'),
          ExportNamedDeclaration: (node) => node.source && check(node, node.source.value, node.exportKind === 'type'),
          ExportAllDeclaration: (node) => check(node, node.source.value, node.exportKind === 'type'),
          ImportExpression: (node) => node.source.type === 'Literal' && check(node, node.source.value, false),
          TSImportType: (node) => {
            const literal = node.argument?.literal ?? node.argument
            if (literal && literal.type === 'Literal') check(node, literal.value, true)
          },
        }
      },
    },
  },
}

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
  {
    files: ['src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { boundaries },
    rules: { 'boundaries/areas': 'error' },
  },
])
