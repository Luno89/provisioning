import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import type { GroupDefinition, Procedure } from '../schema.js';
import type { NodeCatalogue } from '../definition.js';
import { BUILDER_MODULE } from './emit.js';
import {
  BuilderError,
  createProcedureBuilder,
  handleOf,
  isBuilderFunction,
  isBuilderValue,
} from './runtime.js';

export interface BuilderProblem {
  message: string;
  line: number;
  column: number;
}

export type ParsedBuilderCode =
  | { ok: true; procedure: Procedure; unplaced: string[] }
  | { ok: false; problems: BuilderProblem[] };

export interface ParseOptions {
  catalogue: NodeCatalogue;
  groups?: readonly GroupDefinition[] | undefined;
}

class Refusal extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, node: t.Node | null | undefined) {
    super(message);
    this.name = 'Refusal';
    this.line = node?.loc?.start.line ?? 1;
    this.column = (node?.loc?.start.column ?? 0) + 1;
  }
}

const SOURCE_KINDS = new Set(['output', 'group-input', 'group-exit', 'group']);

const describeNode = (node: t.Node): string => {
  switch (node.type) {
    case 'FunctionExpression':
    case 'FunctionDeclaration':
      return 'a function';
    case 'ArrowFunctionExpression':
      return 'a function';
    case 'ForStatement':
    case 'ForOfStatement':
    case 'ForInStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
      return 'a loop';
    case 'IfStatement':
    case 'ConditionalExpression':
      return 'a condition';
    case 'TemplateLiteral':
      return 'a template with ${…} in it';
    case 'NewExpression':
      return '"new"';
    case 'AwaitExpression':
      return '"await"';
    case 'AssignmentExpression':
      return 'an assignment';
    case 'SpreadElement':
      return 'a spread (...)';
    default:
      return `"${node.type}"`;
  }
};

function refuse(node: t.Node, what = describeNode(node)): never {
  throw new Refusal(`${what} is not part of the builder — it can only use const, the builder's calls, .on(…), .wire(…) and plain values`, node);
}

type Scope = Map<string, unknown>;

function evaluate(node: t.Node, scope: Scope): unknown {
  switch (node.type) {
    case 'StringLiteral':
      return node.value;
    case 'NumericLiteral':
      return node.value;
    case 'BooleanLiteral':
      return node.value;
    case 'NullLiteral':
      return null;
    case 'TemplateLiteral':
      if (node.expressions.length > 0) refuse(node);
      return node.quasis.map((quasi) => quasi.value.cooked ?? '').join('');
    case 'UnaryExpression':
      if (node.operator === '-' && node.argument.type === 'NumericLiteral') return -node.argument.value;
      return refuse(node, `"${node.operator}"`);
    case 'ArrayExpression':
      return node.elements.map((element) => (element === null ? refuse(node, 'an empty slot in a list') : evaluate(element, scope)));
    case 'ObjectExpression': {
      const result: Record<string, unknown> = {};
      for (const property of node.properties) {
        if (property.type !== 'ObjectProperty' || property.computed) refuse(property, property.type === 'SpreadElement' ? 'a spread (...)' : 'a method or computed key');
        const name = property.key.type === 'Identifier' ? property.key.name : property.key.type === 'StringLiteral' ? property.key.value : refuse(property.key);
        if (property.shorthand) refuse(property, `the shorthand "{ ${name} }"`);
        if (name === '__proto__' || name === 'constructor' || name === 'prototype') refuse(property.key, `a key called "${name}"`);
        result[name] = evaluate(property.value, scope);
      }
      return result;
    }
    case 'Identifier': {
      if (!scope.has(node.name)) throw new Refusal(`"${node.name}" is not declared — declare it with const first`, node);
      return scope.get(node.name);
    }
    case 'MemberExpression': {
      if (node.computed) refuse(node, 'reading with [ ]');
      if (node.property.type !== 'Identifier') refuse(node.property);
      const target = evaluate(node.object, scope);
      const name = node.property.name;
      if (!isBuilderValue(target) || SOURCE_KINDS.has(String((target as { kind?: unknown }).kind))) {
        throw new Refusal(`there is nothing called "${name}" here`, node.property);
      }
      if (!Object.prototype.hasOwnProperty.call(target, name)) {
        const handle = handleOf(target);
        throw new Refusal(handle
          ? `${handle.definition.title} "${handle.id}" has no output or method called "${name}" — its outputs are ${handle.definition.outputs.map((output) => output.name).join(', ') || 'none'}`
          : `there is nothing called "${name}" here`, node.property);
      }
      return (target as Record<string, unknown>)[name];
    }
    case 'CallExpression': {
      const callee = evaluate(node.callee, scope);
      if (!isBuilderFunction(callee)) throw new Refusal('only the builder\'s own calls can be made', node.callee);
      const args = node.arguments.map((argument) => {
        if (argument.type === 'ArrowFunctionExpression') return bodyFunction(argument, scope);
        if (argument.type === 'SpreadElement' || argument.type === 'ArgumentPlaceholder') return refuse(argument);
        return evaluate(argument, scope);
      });
      try {
        return callee(...args);
      } catch (err) {
        if (err instanceof BuilderError) throw new Refusal(err.message, node);
        throw err;
      }
    }
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
    case 'TSTypeAssertion':
      return refuse(node, 'a type annotation');
    default:
      return refuse(node);
  }
}

function bodyFunction(fn: t.ArrowFunctionExpression, scope: Scope): (api: unknown) => void {
  if (fn.async) refuse(fn, 'an async function');
  if (fn.params.length !== 1 || fn.params[0]!.type !== 'Identifier') refuse(fn, 'a body that does not take exactly one name, like (g) =>');
  if ((fn.params[0] as t.Identifier).typeAnnotation) refuse(fn.params[0]!, 'a type annotation');
  if (fn.body.type !== 'BlockStatement') refuse(fn.body, 'a body without { }');
  const parameter = (fn.params[0] as t.Identifier).name;
  const block = fn.body as t.BlockStatement;

  return (api: unknown) => {
    const inner: Scope = new Map(scope);
    declare(inner, parameter, api, fn.params[0]!);
    run(block.body, inner);
  };
}

function declare(scope: Scope, name: string, value: unknown, at: t.Node): void {
  if (name === 'procedure') throw new Refusal('"procedure" is the builder itself and cannot be declared again', at);
  scope.set(name, value);
}

function run(statements: readonly t.Statement[], scope: Scope): void {
  const declared = new Set<string>();
  for (const statement of statements) {
    if (statement.type === 'EmptyStatement') continue;
    if (statement.type === 'VariableDeclaration') {
      if (statement.kind !== 'const') refuse(statement, `"${statement.kind}"`);
      for (const declaration of statement.declarations) {
        if (declaration.id.type !== 'Identifier') refuse(declaration.id, 'unpacking with { } or [ ]');
        if (declaration.id.typeAnnotation) refuse(declaration.id, 'a type annotation');
        if (!declaration.init) refuse(declaration, 'a const with no value');
        const name = declaration.id.name;
        if (declared.has(name)) throw new Refusal(`"${name}" is already declared`, declaration.id);
        declared.add(name);
        declare(scope, name, evaluate(declaration.init, scope), declaration.id);
      }
      continue;
    }
    if (statement.type === 'ExpressionStatement') {
      if (statement.expression.type !== 'CallExpression') refuse(statement.expression);
      evaluate(statement.expression, scope);
      continue;
    }
    refuse(statement);
  }
}

export function builderCodeToProcedure(code: string, options: ParseOptions): ParsedBuilderCode {
  let file: t.File;
  try {
    file = parse(code, { sourceType: 'module', plugins: ['typescript'], errorRecovery: false });
  } catch (err) {
    const loc = (err as { loc?: { line: number; column: number } }).loc;
    const message = (err as Error).message.replace(/\s*\(\d+:\d+\)$/, '');
    return { ok: false, problems: [{ message, line: loc?.line ?? 1, column: (loc?.column ?? 0) + 1 }] };
  }

  const builder = createProcedureBuilder(options);
  let built: ReturnType<typeof builder> | undefined;

  try {
    const program = file.program;
    for (const statement of program.body) {
      if (statement.type === 'ImportDeclaration') {
        if (statement.source.value !== BUILDER_MODULE) throw new Refusal(`only ${BUILDER_MODULE} can be imported`, statement.source);
        const plain = statement.specifiers.every((specifier) =>
          specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' && specifier.imported.name === 'procedure' && specifier.local.name === 'procedure');
        if (!plain) throw new Refusal('import only { procedure }', statement);
        continue;
      }
      if (statement.type === 'ExportDefaultDeclaration') {
        if (built) throw new Refusal('there can be only one procedure', statement);
        const call = statement.declaration;
        if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier' || call.callee.name !== 'procedure') {
          throw new Refusal('the default export has to be procedure({ … }, (p) => { … })', call);
        }
        const [meta, body, ...rest] = call.arguments;
        if (!meta || !body || rest.length > 0) throw new Refusal('procedure takes the procedure\'s id, name and budget, then its body', call);
        if (body.type !== 'ArrowFunctionExpression') throw new Refusal('the procedure\'s body has to be written as (p) => { … }', body);
        if (meta.type === 'SpreadElement' || meta.type === 'ArgumentPlaceholder') refuse(meta);
        const scope: Scope = new Map();
        const metaValue = evaluate(meta, scope);
        try {
          built = builder(metaValue as never, bodyFunction(body, scope) as never);
        } catch (err) {
          if (err instanceof BuilderError) throw new Refusal(err.message, call);
          throw err;
        }
        continue;
      }
      refuse(statement);
    }
    if (!built) throw new Refusal('there is no procedure here — write export default procedure({ … }, (p) => { … })', file.program);
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, problems: [{ message: err.message, line: err.line, column: err.column }] };
    throw err;
  }

  return { ok: true, procedure: built.procedure, unplaced: built.unplaced };
}
