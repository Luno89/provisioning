import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import { bugBacked, SWALLOWING } from '../../eslint.bug-backed.mjs'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src')

const LAYERS = [
  { files: ['src/*/lib/**/*.ts'], above: ['services', 'routes', 'wiring', 'middleware', 'activities', 'workflows', 'engine-host', 'extensions'], message: 'lib is pure: it imports nothing above it' },
  { files: ['src/*/services/**/*.ts'], above: ['routes', 'wiring', 'middleware'], message: 'a service never imports a route, the wiring or middleware' },
  { files: ['src/*/routes/**/*.ts'], above: ['wiring'], message: 'a route takes its deps from the wiring, never imports it' },
]

const upward = (folders) => folders.flatMap((folder) => [`**/${folder}/*`, `**/${folder}/**`, `../${folder}`, `../../${folder}`])

const AREAS = ['platform', 'accounts', 'instances', 'hub', 'projects', 'releases', 'files', 'machines', 'monitoring', 'models', 'memory', 'checks', 'infrastructure', 'engine']


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
          if (to.kind !== 'area' || (from.kind === 'area' && from.name === to.name)) return
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

const CLUSTER_TOOLS = ['kubectl', 'helm']
const SPAWNERS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'execa', 'execShell', 'shell']
const PATH_BUILDERS = ['join', 'resolve']

const toolNamed = (text) => {
  if (typeof text !== 'string') return undefined
  const first = text.trim().split(/\s+/)[0] ?? ''
  const base = first.split('/').pop()
  return CLUSTER_TOOLS.includes(base) ? base : undefined
}

const textOf = (node) => {
  if (!node) return undefined
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral') return node.quasis.map((quasi) => quasi.value.cooked ?? '').join('X')
  return undefined
}

const calleeName = (node) => (node.callee.type === 'Identifier' ? node.callee.name : node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier' ? node.callee.property.name : undefined)

const builtPathTo = (node) => {
  if (node?.type !== 'CallExpression' || !PATH_BUILDERS.includes(calleeName(node))) return undefined
  const parts = node.arguments.map(textOf)
  const last = parts[parts.length - 1]
  if (typeof last !== 'string') return undefined
  const tail = last.split('/').pop()
  return CLUSTER_TOOLS.includes(tail) && (parts.length > 1 || last.includes('/')) ? tail : undefined
}

const startsTool = (node) => toolNamed(textOf(node)) ?? builtPathTo(node)

const ONE_DOOR = 'only infrastructure/services/ClusterAccess.ts starts kubectl or helm: reach a cluster through ClusterAccess'

const clusters = {
  rules: {
    'one-door': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        const report = (node, tool) => context.report({ node, message: `${tool}: ${ONE_DOOR}` })
        return {
          CallExpression(node) {
            const name = calleeName(node)
            if (SPAWNERS.includes(name)) {
              const tool = startsTool(node.arguments[0])
              if (tool) report(node, tool)
              return
            }
            const tool = builtPathTo(node)
            if (tool) report(node, tool)
          },
          Property(node) {
            if (node.key.type !== 'Identifier' || node.key.name !== 'command') return
            const run = node.parent?.type === 'ObjectExpression' && node.parent.properties.some((other) => other.type === 'Property' && other.key.type === 'Identifier' && other.key.name === 'args')
            if (!run) return
            const tool = startsTool(node.value)
            if (tool) report(node, tool)
          },
          MemberExpression(node) {
            if (node.object.type === 'Identifier' && node.object.name === 'TOOLS' && node.property.type === 'Identifier' && CLUSTER_TOOLS.includes(node.property.name)) report(node, node.property.name)
          },
        }
      },
    },
  },
}

const UNAWAITED_HANDLER = { selector: "CallExpression[callee.property.name=/^(get|post|put|patch|delete|use|all)$/] > :matches(ArrowFunctionExpression, FunctionExpression)[async=true]", message: 'Express 4 never awaits a handler, so one that rejects sends no response and the request hangs: wrap it in asyncRoute' }

const ACCESS = [
  { selector: "MemberExpression[property.name='isAdmin']", message: 'who may do what is decided by authorize in platform/lib/permissions.ts, from the claims claimsOf gives; there is no isAdmin' },
  { selector: "MemberExpression[property.name='roles']", message: 'a person\'s stored roles become claims in claimsOf (platform/lib/permissions.ts) and are read nowhere else; ask authorize' },
  { selector: "CallExpression[callee.name='can']", message: 'a shared project\'s roles are decided by authorize in platform/lib/permissions.ts' },
]


const TESTING_ONLY = { group: ['**/testing/*'], message: 'a testing/ folder holds mocks and contract suites for tests; production code never imports them' };

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
  {
    files: ['src/**/*.ts'],
    ignores: ['**/*.test.ts', 'src/**/testing/**'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-imports': ['error', { patterns: [TESTING_ONLY] }],
    },
  },
  ...LAYERS.map((layer) => ({
    files: layer.files,
    ignores: ['**/*.test.ts', 'src/**/testing/**'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: upward(layer.above), message: layer.message }, TESTING_ONLY] }],
    },
  })),
  {
    files: ['src/**/*.ts'],
    ignores: ['**/*.test.ts', 'src/**/testing/**'],
    languageOptions: { parser: tseslint.parser },
    plugins: { boundaries },
    rules: { 'boundaries/areas': 'error' },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['**/*.test.ts', 'src/platform/lib/permissions.ts', 'src/*/store.ts', 'src/*/testing/memory-store.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-syntax': ['error', ...ACCESS, ...SWALLOWING, UNAWAITED_HANDLER],
    },
  },
  {
    files: ['src/*/lib/**/*.ts'],
    ignores: ['**/*.test.ts', 'src/platform/lib/permissions.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-syntax': ['error', ...ACCESS, ...SWALLOWING, UNAWAITED_HANDLER, { selector: "MemberExpression[object.name='process'][property.name='env']", message: 'lib is pure: it takes settings as arguments and never reads process.env, which may not be loaded yet when it runs' }],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['**/*.test.ts', 'src/**/testing/**', 'src/infrastructure/services/ClusterAccess.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { clusters },
    rules: { 'clusters/one-door': 'error' },
  },
  bugBacked({ files: ['src/**/*.ts'], root: path.dirname(fileURLToPath(import.meta.url)) }),
])
