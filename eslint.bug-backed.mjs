import tseslint from 'typescript-eslint'

const SWALLOWED = ":matches([body.type='Identifier'][body.name='undefined'], [body.type='BlockStatement'][body.body.length=0], [body.type='Literal'], [body.type='ArrayExpression'][body.elements.length=0], [body.type='ObjectExpression'][body.properties.length=0])"
const SWALLOW_MESSAGE = 'a failure dropped silently turns into a hang or a wrong answer later: handle it, or say why it does not matter with ignore(why) from @koala/engine-core/failures'

export const SWALLOWING = [
  { selector: 'CatchClause > BlockStatement[body.length=0]', message: SWALLOW_MESSAGE },
  { selector: `CallExpression[callee.property.name='catch'] > ArrowFunctionExpression.arguments[params.length=0]${SWALLOWED}`, message: SWALLOW_MESSAGE },
  { selector: `CallExpression[callee.property.name='then'][arguments.length=2] > ArrowFunctionExpression.arguments:nth-child(2)[params.length=0]${SWALLOWED}`, message: SWALLOW_MESSAGE },
  { selector: "CallExpression[callee.property.name=/^(start|signalWithStart|execute)$/][callee.object.property.name='workflow'] > Literal.arguments:first-child", message: 'start a workflow by its function, so a renamed or misspelt workflow fails the typecheck rather than every start' },
]

export const BUG_BACKED = {
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-unsafe-member-access': 'error',
  '@typescript-eslint/no-unsafe-assignment': 'error',
  '@typescript-eslint/no-unsafe-argument': 'error',
  '@typescript-eslint/no-unsafe-call': 'error',
  '@typescript-eslint/no-unsafe-return': 'error',
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/only-throw-error': 'error',
  '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
  'no-empty': ['error', { allowEmptyCatch: false }],
}

export function bugBacked({ files, root, project = true }) {
  return {
    files,
    languageOptions: { parser: tseslint.parser, parserOptions: { ...(project === true ? { projectService: true } : { project }), tsconfigRootDir: root } },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: BUG_BACKED,
  }
}
