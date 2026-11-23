import tseslint from 'typescript-eslint'

const SWALLOWED = ":matches([body.type='Identifier'][body.name='undefined'], [body.type='BlockStatement'][body.body.length=0], [body.type='Literal'], [body.type='ArrayExpression'][body.elements.length=0], [body.type='ObjectExpression'][body.properties.length=0])"
const SWALLOW_MESSAGE = 'a failure dropped silently turns into a hang or a wrong answer later: handle it, or say why it does not matter with ignore(why) from @koala/engine-core/failures'

const MADE_UP = (key) => `:matches([${key}=null], [${key}.type='Identifier'][${key}.name='undefined'], [${key}.type='Literal'], [${key}.type='ArrayExpression'][${key}.elements.length=0], [${key}.type='ObjectExpression'][${key}.properties.length=0])`
const MADE_UP_MESSAGE = 'a failure answered with a made-up value is shown to the person as if it were true: return the failure with its reason, or say why it does not matter with ignore(why) from @koala/engine-core/failures'
const WARN_MESSAGE = 'a failure that is only logged is lost to the person, who sees the work carry on as if it had worked: handle it, throw it, or say why it does not matter with ignore(why) from @koala/engine-core/failures'
const HANDLER_MESSAGE = 'Express 4 never awaits a handler, so one that rejects sends no response and the request hangs: wrap it in asyncRoute'

export const ASYNC_HANDLER_IN_VARIABLE = {
  selector: ":matches(VariableDeclarator[id.typeAnnotation.typeAnnotation.typeName.name='RequestHandler'], VariableDeclarator[id.typeAnnotation.typeAnnotation.typeName.right.name='RequestHandler']) > :matches(ArrowFunctionExpression, FunctionExpression).init[async=true]",
  message: HANDLER_MESSAGE,
}

const consoleCall = (statement) => {
  if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'CallExpression') return false
  const callee = statement.expression.callee
  return callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'console'
}

const onlyConsole = (block) => block.body.length > 0 && block.body.every(consoleCall)

const isFunction = (node) => node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression'

const failureHandler = (call) => {
  if (call.callee.type !== 'MemberExpression' || call.callee.property.type !== 'Identifier') return undefined
  if (call.callee.property.name === 'catch') return isFunction(call.arguments[0]) ? call.arguments[0] : undefined
  if (call.callee.property.name === 'then' && call.arguments.length === 2) return isFunction(call.arguments[1]) ? call.arguments[1] : undefined
  return undefined
}

export const FAILURES_PLUGIN = {
  rules: {
    'no-warn-and-carry-on': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        return {
          CatchClause(node) {
            if (onlyConsole(node.body)) context.report({ node, message: WARN_MESSAGE })
          },
          CallExpression(node) {
            const handler = failureHandler(node)
            if (handler && handler.body.type === 'BlockStatement' && onlyConsole(handler.body)) context.report({ node: handler, message: WARN_MESSAGE })
          },
        }
      },
    },
  },
}

const FUNCTION = ':matches(ArrowFunctionExpression, FunctionExpression)'

export const SWALLOWING = [
  { selector: `CallExpression[callee.property.name='catch'] > ${FUNCTION}.arguments > BlockStatement > ReturnStatement${MADE_UP('argument')}`, message: MADE_UP_MESSAGE },
  { selector: `CallExpression[callee.property.name='then'][arguments.length=2] > ${FUNCTION}.arguments:nth-child(2) > BlockStatement > ReturnStatement${MADE_UP('argument')}`, message: MADE_UP_MESSAGE },
  { selector: `CatchClause > BlockStatement > ReturnStatement${MADE_UP('argument')}`, message: MADE_UP_MESSAGE },
  { selector: `CallExpression[callee.property.name='catch'] > ArrowFunctionExpression.arguments[params.length>0]${SWALLOWED}`, message: MADE_UP_MESSAGE },
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
  'failures/no-warn-and-carry-on': 'error',
}

export function bugBacked({ files, root, project = true }) {
  return {
    files,
    languageOptions: { parser: tseslint.parser, parserOptions: { ...(project === true ? { projectService: true } : { project }), tsconfigRootDir: root } },
    plugins: { '@typescript-eslint': tseslint.plugin, failures: FAILURES_PLUGIN },
    rules: BUG_BACKED,
  }
}
