import ts from 'typescript';

export const NO_OP_FUNCTIONS: readonly { file: string; name: string }[] = [{ file: 'packages/engine-core/src/failures.ts', name: 'ignore' }];

const LOG_FILE_WRITES = new Set(['appendFile', 'appendFileSync']);

function logs(expression: ts.Expression): boolean {
  const inner = ts.isParenthesizedExpression(expression) ? expression.expression : expression;
  if (ts.isConditionalExpression(inner)) return logsOrNothing(inner.whenTrue) && logsOrNothing(inner.whenFalse);
  if (!ts.isCallExpression(inner)) return false;
  const callee = inner.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    if (callee.name.text === 'catch' && ts.isCallExpression(callee.expression)) return logs(callee.expression);
    if (ts.isIdentifier(callee.expression) && callee.expression.text === 'console') return true;
    if (LOG_FILE_WRITES.has(callee.name.text)) return true;
  }
  return false;
}

function logsOrNothing(expression: ts.Expression): boolean {
  const inner = ts.isParenthesizedExpression(expression) ? expression.expression : expression;
  const resolvedNothing = ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)
    && ts.isIdentifier(inner.expression.expression) && inner.expression.expression.text === 'Promise' && inner.expression.name.text === 'resolve' && inner.arguments.length === 0;
  return resolvedNothing || logs(inner);
}

export function onlyLogs(node: ts.Node): boolean {
  if (!ts.isFunctionLike(node)) return false;
  const body = (node as ts.FunctionLikeDeclaration).body;
  if (!body) return false;
  if (!ts.isBlock(body)) return logs(body);
  return body.statements.length > 0 && body.statements.every((statement) =>
    (ts.isExpressionStatement(statement) && logs(statement.expression)) || (ts.isReturnStatement(statement) && statement.expression !== undefined && logs(statement.expression)));
}
