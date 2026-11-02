import ts from 'typescript';
import { isTestFile, type ChannelEnd } from './graph.js';
import { localsOf, pathsOf, served, type Locals } from './http-edges.js';

const TESTING_FOLDER = /\/testing\//;
const EXPRESS_TYPES = /\/node_modules\/@types\/(express|express-serve-static-core)\//;
const AXIOS_TYPES = /\/node_modules\/axios\//;
const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const ROUTED = new Set([...VERBS, 'all']);
const ROUTER_INTERFACES = /^(IRouterMatcher|IRouterHandler|IRoute|IRouter|Application|Express)$/;

const declaredIn = (type: ts.Type, files: RegExp): boolean => {
  const plain = type.getNonNullableType();
  return (plain.isUnion() ? plain.types : [plain]).some((part) => [part.getSymbol(), part.aliasSymbol].some((symbol) => (symbol?.getDeclarations() ?? []).some((declaration) => files.test(declaration.getSourceFile().fileName))));
};

const joined = (prefix: string, path: string): string => `${prefix}${path === '/' ? '' : path}`.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';

export const httpMatches = (sent: string, heard: string): boolean => {
  const [method, path] = sent.split(' ');
  const [routeMethod, routePath] = heard.split(' ');
  if (!method || !path || !routeMethod || !routePath) return false;
  const routes = [{ method: routeMethod, path: routePath }];
  if (served({ method, path }, routes)) return true;
  if (!/[^/]:\*$/.test(path)) return false;
  const base = path.slice(0, -2);
  return [base, `${base}/:*`, `${base}/:*/:*`].some((candidate) => served({ method, path: candidate }, routes));
};

const FETCH_TYPES = /\/node_modules\/(typescript\/lib\/lib\.dom|undici-types|@types\/node)\//;

export interface KoalaClient { file: RegExp; name: string; base: string }

export const FRONTEND_CLIENT: KoalaClient = { file: /\/apps\/frontend\/src\/api\/client\.ts$/, name: 'api', base: '/api' };

export function httpChannels(program: ts.Program, clients: readonly KoalaClient[] = [FRONTEND_CLIENT]): (call: ts.CallExpression) => ChannelEnd[] | undefined {
  const checker = program.getTypeChecker();
  const aliased = (symbol: ts.Symbol | undefined) => (symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
  const literalsOf = (expression: ts.Expression | undefined): string[] | undefined => {
    if (!expression) return undefined;
    if (ts.isRegularExpressionLiteral(expression)) return [expression.text.slice(0, expression.text.lastIndexOf('/'))];
    if (ts.isTemplateExpression(expression)) {
      let found = [expression.head.text];
      for (const span of expression.templateSpans) {
        const parts = literalsOf(span.expression);
        if (!parts) return undefined;
        found = found.flatMap((before) => parts.map((part) => `${before}${part}${span.literal.text}`));
      }
      return found;
    }
    const type = checker.getTypeAtLocation(expression);
    const parts = type.isUnion() ? type.types : [type];
    const values = parts.map((part) => (part.isStringLiteral() ? part.value : undefined));
    return values.every((value): value is string => value !== undefined) ? values : undefined;
  };
  const literal = (expression: ts.Expression | undefined): string | undefined => {
    const values = literalsOf(expression);
    return values?.length === 1 ? values[0] : undefined;
  };
  const onExpress = (call: ts.CallExpression): string | undefined => {
    if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
    const method = call.expression.name.text;
    if (!ROUTED.has(method) && method !== 'use') return undefined;
    const signature = checker.getResolvedSignature(call);
    const declaration = signature?.getDeclaration();
    if (declaration && EXPRESS_TYPES.test(declaration.getSourceFile().fileName)) {
      let owner: ts.Node | undefined = declaration;
      while (owner && !ts.isInterfaceDeclaration(owner)) owner = owner.parent;
      return owner && ROUTER_INTERFACES.test(owner.name.text) ? method : undefined;
    }
    const handler = signature?.parameters[signature.parameters.length - 1];
    if (call.arguments.length >= 2 && handler && declaredIn(checker.getTypeOfSymbolAtLocation(handler, call), EXPRESS_TYPES)) return method;
    return declaredIn(checker.getTypeAtLocation(call.expression.expression), EXPRESS_TYPES) ? method : undefined;
  };
  const enclosingFunction = (node: ts.Node): ts.Node | undefined => {
    for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionLike(parent)) return parent;
    return undefined;
  };
  const factoryOf = (call: ts.Expression): ts.Node | undefined => {
    if (!ts.isCallExpression(call)) return undefined;
    const wrapped = call.arguments.find((argument) => ts.isCallExpression(argument) && declaredIn(checker.getTypeAtLocation(argument), EXPRESS_TYPES));
    if (wrapped) return factoryOf(wrapped);
    const declaration = aliased(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression))?.valueDeclaration;
    if (!declaration) return undefined;
    if (ts.isFunctionDeclaration(declaration)) return declaration;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) return declaration.initializer;
    return undefined;
  };

  const mounts: Array<{ inside: ts.Node | undefined; prefix: string; factory: ts.Node }> = [];
  for (const source of program.getSourceFiles()) {
    if (source.fileName.includes('/node_modules/') || source.isDeclarationFile || isTestFile(source.fileName) || TESTING_FOLDER.test(source.fileName)) continue;
    const visit = (node: ts.Node) => {
      const mounted = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'use' ? node.arguments[node.arguments.length - 1] : undefined;
      if (ts.isCallExpression(node) && mounted && declaredIn(checker.getTypeAtLocation(mounted), EXPRESS_TYPES)) {
        const prefix = node.arguments.length > 1 ? literal(node.arguments[0]) : '';
        const factory = mounted ? factoryOf(mounted) : undefined;
        if (prefix !== undefined && factory) mounts.push({ inside: enclosingFunction(node), prefix, factory });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const prefixes = new Map<ts.Node, Set<string>>();
  const makesRouter = (fn: ts.Node): boolean => {
    const signature = ts.isFunctionLike(fn) ? checker.getSignatureFromDeclaration(fn) : undefined;
    return signature !== undefined && declaredIn(checker.getReturnTypeOfSignature(signature), EXPRESS_TYPES);
  };
  const rootPrefixes = (inside: ts.Node | undefined): string[] => {
    if (!inside) return [''];
    const known = prefixes.get(inside);
    if (known) return [...known];
    return mounts.some((mount) => mount.factory === inside) || makesRouter(inside) ? [] : [''];
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const mount of mounts) {
      const known = prefixes.get(mount.factory) ?? new Set<string>();
      for (const outer of rootPrefixes(mount.inside)) {
        const full = joined(outer, mount.prefix);
        if (!known.has(full)) { known.add(full); changed = true; }
      }
      prefixes.set(mount.factory, known);
    }
  }

  const handlerOf = (argument: ts.Expression | undefined): ts.Node | undefined => {
    if (!argument) return undefined;
    if (ts.isCallExpression(argument)) {
      const inner = argument.arguments.find((candidate) => ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate) || ts.isIdentifier(candidate));
      return inner ? handlerOf(inner) : argument.expression;
    }
    return argument;
  };

  const locals = new Map<ts.SourceFile, Locals>();

  const isFetch = (call: ts.CallExpression): boolean => {
    const declaration = checker.getResolvedSignature(call)?.getDeclaration();
    return !!declaration && ts.isFunctionDeclaration(declaration) && declaration.name?.text === 'fetch' && FETCH_TYPES.test(declaration.getSourceFile().fileName);
  };
  const urlPaths = (expression: ts.Expression | undefined, depth = 0): string[] | undefined => {
    if (!expression || depth > 4) return undefined;
    const known = literalsOf(expression);
    if (known) return known;
    if (ts.isParenthesizedExpression(expression)) return urlPaths(expression.expression, depth + 1);
    if (ts.isIdentifier(expression)) {
      const declaration = aliased(checker.getSymbolAtLocation(expression))?.valueDeclaration;
      return declaration && ts.isVariableDeclaration(declaration) && declaration.initializer ? urlPaths(declaration.initializer, depth + 1) : undefined;
    }
    if (ts.isNewExpression(expression) && expression.expression.getText() === 'URL') return urlPaths(expression.arguments?.[0], depth + 1);
    if (ts.isTemplateExpression(expression)) {
      let found = [expression.head.text];
      for (const span of expression.templateSpans) {
        const parts = urlPaths(span.expression, depth + 1) ?? [':*'];
        found = found.flatMap((before) => parts.map((part) => `${before}${part}${span.literal.text}`));
      }
      return found;
    }
    return undefined;
  };
  const methodOf = (init: ts.Expression | undefined): string[] => {
    if (!init || !ts.isObjectLiteralExpression(init)) return ['GET'];
    const named = init.properties.find((property) => property.name?.getText() === 'method');
    const value = named && ts.isPropertyAssignment(named) ? literalsOf(named.initializer) : undefined;
    return value ? value.map((method) => method.toUpperCase()) : named ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] : ['GET'];
  };

  return (call) => {
    const method = onExpress(call);
    if (method && method !== 'use') {
      const paths = literalsOf(call.arguments[0]);
      if (!paths || !paths.every((path) => path.startsWith('/'))) return undefined;
      const inside = enclosingFunction(call);
      const handler = handlerOf(call.arguments[call.arguments.length - 1]);
      const verb = method === 'all' ? '_ALL' : method.toUpperCase();
      return rootPrefixes(inside).flatMap((prefix) => paths.map((path) => ({ kind: 'http' as const, name: `${verb} ${joined(prefix, path)}`, side: 'hears' as const, ...(handler ? { handler } : {}) })));
    }
    if (isFetch(call)) {
      const paths = (urlPaths(call.arguments[0]) ?? []).map((path) => path.replace(/^:\*/, '').split('?')[0]!).filter((path) => path.startsWith('/'));
      return paths.flatMap((path) => methodOf(call.arguments[1]).map((verb) => ({ kind: 'http' as const, name: `${verb} ${joined('', path)}`, side: 'sends' as const })));
    }
    if (!ts.isPropertyAccessExpression(call.expression) || !VERBS.has(call.expression.name.text) || !call.arguments[0]) return undefined;
    if (!declaredIn(checker.getTypeAtLocation(call.expression.expression), AXIOS_TYPES)) return undefined;
    const receiver = aliased(checker.getSymbolAtLocation(call.expression.expression))?.valueDeclaration;
    const client = receiver && clients.find((known) => known.file.test(receiver.getSourceFile().fileName) && ts.isVariableDeclaration(receiver) && receiver.name.getText() === known.name);
    if (!client) return undefined;
    const source = call.getSourceFile();
    if (!locals.has(source)) locals.set(source, localsOf(source));
    const paths = pathsOf(call.arguments[0], locals.get(source)!);
    if (!paths) return undefined;
    const verb = call.expression.name.text.toUpperCase();
    return paths.map((path) => ({ kind: 'http', name: `${verb} ${joined(client.base, path.split('?')[0]!)}`, side: 'sends' }));
  };
}
