import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

export interface Route { method: string; path: string }
export interface ClientCall { method: string; path: string; file: string; line: number }
export interface UnreadCall { file: string; line: number; text: string }

interface Layer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: Layer[] };
  regexp?: RegExp & { fast_slash?: boolean };
  keys?: Array<{ name: string }>;
}

function mountOf(layer: Layer): string {
  if (!layer.regexp || layer.regexp.fast_slash) return '';
  let source = layer.regexp.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\(\?=\\\/\|\$\)$/, '');
  let key = 0;
  source = source.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${layer.keys?.[key++]?.name ?? 'param'}`);
  return source.replace(/\\\//g, '/').replace(/\\(.)/g, '$1');
}

export function routesOf(app: { _router?: { stack: Layer[] } }): Route[] {
  const found: Route[] = [];
  const walk = (stack: Layer[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const method of Object.keys(layer.route.methods)) for (const path of paths) found.push({ method: method.toUpperCase(), path: `${prefix}${path}`.replace(/\/+$/, '') || '/' });
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, `${prefix}${mountOf(layer)}`);
      }
    }
  };
  walk(app._router?.stack ?? [], '');
  return found;
}

const VERBS = new Set(['get', 'post', 'put', 'delete', 'patch']);

type Locals = Map<string, ts.Expression>;

function localsOf(source: ts.SourceFile): Locals {
  const locals: Locals = new Map();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) locals.set(declaration.name.text, declaration.initializer);
    }
  }
  return locals;
}

function pathsOf(node: ts.Expression, locals: Locals, depth = 0): string[] | undefined {
  if (depth > 4) return undefined;
  if (ts.isParenthesizedExpression(node)) return pathsOf(node.expression, locals, depth);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isConditionalExpression(node)) {
    const both = [pathsOf(node.whenTrue, locals, depth + 1), pathsOf(node.whenFalse, locals, depth + 1)];
    return both.every(Boolean) ? both.flat() as string[] : undefined;
  }
  if (ts.isIdentifier(node)) {
    const value = locals.get(node.text);
    return value && !ts.isArrowFunction(value) ? pathsOf(value, locals, depth + 1) : undefined;
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const value = locals.get(node.expression.text);
    if (value && ts.isArrowFunction(value) && !ts.isBlock(value.body)) return pathsOf(value.body, locals, depth + 1);
    return undefined;
  }
  if (ts.isTemplateExpression(node)) {
    let paths = [node.head.text];
    for (const span of node.templateSpans) {
      const parts = pathsOf(span.expression, locals, depth + 1) ?? [':*'];
      paths = paths.flatMap((before) => parts.map((part) => `${before}${part}${span.literal.text}`));
    }
    return paths;
  }
  return undefined;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

export function clientCallsIn(dir: string, root: string, client = 'api', base = '/api'): { calls: ClientCall[]; unread: UnreadCall[] } {
  const calls: ClientCall[] = [];
  const unread: UnreadCall[] = [];
  for (const file of sourceFiles(dir)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes(`${client}.`)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const locals = localsOf(source);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === client && VERBS.has(node.expression.name.text) && node.arguments[0]) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const paths = pathsOf(node.arguments[0], locals);
        if (paths === undefined) unread.push({ file: relative(root, file), line, text: node.arguments[0].getText(source).slice(0, 80) });
        else for (const path of paths) calls.push({ method: node.expression.name.text.toUpperCase(), path: `${base}${path.split('?')[0]}`.replace(/\/+$/, ''), file: relative(root, file), line });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { calls, unread };
}

const segments = (path: string): string[] => path.split('/').filter(Boolean);

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function routePattern(path: string): RegExp {
  const body = segments(path).map((part) => {
    if (/^:[^/]+\?$/.test(part)) return '(?:/[^/]+)?';
    if (part.startsWith(':') || part === '*') return '/[^/]+';
    return `/${escaped(part)}`;
  }).join('');
  return new RegExp(`^${body || '/'}$`);
}

export function served(call: Pick<ClientCall, 'method' | 'path'>, routes: readonly Route[]): boolean {
  const asked = segments(call.path);
  const sample = `/${asked.map((part) => part.replaceAll(':*', 'x0')).join('/')}`;
  return routes.some((route) => {
    if (route.method !== call.method) return false;
    if (routePattern(route.path).test(sample)) return true;
    const offered = segments(route.path);
    if (offered.length !== asked.length) return false;
    return offered.every((part, index) => {
      const mine = asked[index]!;
      if (part.startsWith(':') || part === '*') return true;
      if (!mine.includes(':*')) return part === mine;
      const pattern = new RegExp(`^${mine.split(':*').map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+')}$`);
      return pattern.test(part);
    });
  });
}
