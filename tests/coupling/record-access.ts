import ts from 'typescript';

export interface RecordAccess { collection: string; writes: boolean }

export const UNNAMED = '(a collection named at run time)';

const DRIVER_WRITES = new Set([
  'insertOne', 'insertMany', 'replaceOne', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
  'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'bulkWrite',
]);
const DRIVER_READS = new Set(['find', 'findOne', 'countDocuments', 'estimatedDocumentCount', 'aggregate', 'distinct', 'watch']);

const RECORDS_WRITES = new Set(['put', 'patch', 'remove', 'removeWhere']);
const RECORDS_READS = new Set(['all', 'one', 'byId', 'count']);

const WATCHES = new Set(['watchWrites']);

const COOKIE_WRITES = new Set(['cookie', 'clearCookie']);
const COOKIE_READS = new Set(['getCookie', 'parseCookie']);

export const COOKIE = 'cookie ';

const HELPERS = /\/platform\/lib\/(collection|change-streams)\.ts$/;

type Kind = 'driver' | 'records';

interface Touch { access: RecordAccess; collection: ts.Expression | undefined }

const ownSource = (source: ts.SourceFile): boolean => !source.fileName.includes('/node_modules/') && !source.fileName.endsWith('.d.ts');

export function mongoRecords(program: ts.Program): (call: ts.CallExpression) => RecordAccess[] {
  const checker = program.getTypeChecker();

  function kindOf(type: ts.Type): Kind | undefined {
    const symbol = type.getNonNullableType().getSymbol() ?? type.aliasSymbol;
    const file = symbol?.getDeclarations()?.[0]?.getSourceFile().fileName ?? '';
    if (symbol?.getName() === 'Collection' && file.includes('/node_modules/mongodb/')) return 'driver';
    if (symbol?.getName() === 'Records' && file.endsWith('/platform/lib/collection.ts')) return 'records';
    return undefined;
  }

  function returned(body: ts.Node | undefined): ts.Expression | undefined {
    if (!body) return undefined;
    if (!ts.isBlock(body)) return ts.isExpression(body) ? body : undefined;
    for (const statement of body.statements) if (ts.isReturnStatement(statement) && statement.expression) return statement.expression;
    return undefined;
  }

  function literal(expression: ts.Expression | undefined): string | undefined {
    if (!expression) return undefined;
    const type = checker.getTypeAtLocation(expression);
    return type.isStringLiteral() ? type.value : undefined;
  }

  function nameOf(expression: ts.Expression | undefined, depth = 0): string {
    if (!expression || depth > 6) return UNNAMED;
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) return nameOf(expression.expression, depth + 1);
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return nameOf(returned(expression.body), depth + 1);
    if (ts.isNewExpression(expression)) return literal(expression.arguments?.[1]) ?? UNNAMED;
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'raw' && kindOf(checker.getTypeAtLocation(expression.expression)) === 'records') return nameOf(expression.expression, depth + 1);
    if (ts.isCallExpression(expression)) {
      const callee = expression.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'collection') return literal(expression.arguments[0]) ?? UNNAMED;
      const declaration = checker.getResolvedSignature(expression)?.getDeclaration();
      if (declaration && (ts.isMethodDeclaration(declaration) || ts.isFunctionDeclaration(declaration) || ts.isArrowFunction(declaration))) {
        const inner = returned(declaration.body);
        if (inner) return nameOf(inner, depth + 1);
      }
      return literal(expression.arguments[0]) ?? UNNAMED;
    }
    const symbol = ts.isPropertyAccessExpression(expression) ? checker.getSymbolAtLocation(expression.name) : ts.isIdentifier(expression) ? checker.getSymbolAtLocation(expression) : undefined;
    for (const declaration of symbol?.getDeclarations() ?? []) {
      if (ts.isGetAccessor(declaration)) return nameOf(returned(declaration.body), depth + 1);
      if ((ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) && declaration.initializer) return nameOf(declaration.initializer, depth + 1);
    }
    return UNNAMED;
  }

  function cookieName(expression: ts.Expression | undefined, depth = 0): string | undefined {
    if (!expression || depth > 4) return undefined;
    if (ts.isCallExpression(expression)) return literal(expression.arguments[0]);
    if (ts.isIdentifier(expression)) {
      const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) return cookieName(declaration.initializer, depth + 1);
    }
    return literal(expression);
  }

  function cookieOf(call: ts.CallExpression, named: string | undefined): RecordAccess | undefined {
    if (!named) return undefined;
    const callee = call.expression;
    if (COOKIE_WRITES.has(named) && ts.isPropertyAccessExpression(callee)) {
      const name = cookieName(call.arguments[0]);
      return name ? { collection: `${COOKIE}${name}`, writes: true } : undefined;
    }
    if (COOKIE_READS.has(named)) {
      const name = cookieName(call.arguments[1]);
      return name ? { collection: `${COOKIE}${name}`, writes: false } : undefined;
    }
    return undefined;
  }

  function touchOf(call: ts.CallExpression): Touch | undefined {
    const callee = call.expression;
    const named = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
    const cookie = cookieOf(call, named);
    if (cookie) return { access: cookie, collection: undefined };
    if (named && WATCHES.has(named)) {
      const given = call.arguments[0];
      return given ? { access: { collection: nameOf(given), writes: false }, collection: given } : undefined;
    }
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const kind = kindOf(checker.getTypeAtLocation(callee.expression));
    if (kind === 'driver' && (DRIVER_WRITES.has(named!) || DRIVER_READS.has(named!))) return { access: { collection: nameOf(callee.expression), writes: DRIVER_WRITES.has(named!) }, collection: callee.expression };
    if (kind === 'records' && (RECORDS_WRITES.has(named!) || RECORDS_READS.has(named!))) return { access: { collection: nameOf(callee.expression), writes: RECORDS_WRITES.has(named!) }, collection: callee.expression };
    return undefined;
  }

  function parameterOf(expression: ts.Expression | undefined): ts.ParameterDeclaration | undefined {
    let at = expression;
    while (at) {
      if (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) at = returned(at.body);
      else if (ts.isPropertyAccessExpression(at) && at.name.text === 'raw') at = at.expression;
      else if (ts.isCallExpression(at) && at.arguments.length === 0) at = at.expression;
      else if (ts.isParenthesizedExpression(at) || ts.isNonNullExpression(at)) at = at.expression;
      else break;
    }
    const declaration = at && ts.isIdentifier(at) ? checker.getSymbolAtLocation(at)?.valueDeclaration : undefined;
    return declaration && ts.isParameter(declaration) ? declaration : undefined;
  }

  const passedOn = new Map<ts.Node, Array<{ position: number; writes: boolean }>>();
  for (const source of program.getSourceFiles().filter(ownSource)) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const touch = touchOf(node);
        const parameter = touch && touch.access.collection === UNNAMED ? parameterOf(touch.collection) : undefined;
        if (touch && parameter) {
          const made = parameter.parent;
          passedOn.set(made, [...(passedOn.get(made) ?? []), { position: made.parameters.indexOf(parameter), writes: touch.access.writes }]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return (call) => {
    if (HELPERS.test(call.getSourceFile().fileName)) return [];
    const touch = touchOf(call);
    if (touch) return touch.access.collection === UNNAMED && parameterOf(touch.collection) ? [] : [touch.access];
    const declaration = checker.getResolvedSignature(call)?.getDeclaration();
    const uses = declaration ? passedOn.get(declaration) : undefined;
    return (uses ?? []).map((use) => ({ collection: nameOf(call.arguments[use.position]), writes: use.writes }));
  };
}
