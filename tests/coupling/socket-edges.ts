import ts from 'typescript';
import type { ChannelEnd } from './graph.js';

const SOCKET_TYPES = /\/node_modules\/(socket\.io|socket\.io-client|@socket\.io\/component-emitter)\//;
const SENDS = new Set(['emit', 'emitWithAck']);
const HEARS = new Set(['on', 'once', 'addListener']);
export const RESERVED = new Set(['connect', 'connection', 'disconnect', 'disconnecting', 'connect_error', 'reconnect', 'reconnect_attempt', 'reconnect_error', 'reconnect_failed', 'error', 'newListener', 'removeListener', 'ping']);

interface Wrapper { side: ChannelEnd['side']; event: number; handler: number }

export function socketChannels(program: ts.Program): (call: ts.CallExpression) => ChannelEnd[] | undefined {
  const checker = program.getTypeChecker();
  const aliased = (symbol: ts.Symbol | undefined) => (symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);

  const fromSocketIo = (type: ts.Type): boolean => {
    const plain = type.getNonNullableType();
    const parts = plain.isUnion() ? plain.types : [plain];
    return parts.some((part) => [part.getSymbol(), part.aliasSymbol].some((symbol) => (symbol?.getDeclarations() ?? []).some((declaration) => SOCKET_TYPES.test(declaration.getSourceFile().fileName))));
  };

  const symbolsOf = (type: ts.Type): ts.Symbol[] => {
    const plain = type.getNonNullableType();
    return (plain.isUnion() ? plain.types : [plain]).flatMap((part) => [part.getSymbol(), part.aliasSymbol]).filter((symbol): symbol is ts.Symbol => symbol !== undefined);
  };
  const ownCode = (node: ts.Node): boolean => !node.getSourceFile().fileName.includes('/node_modules/');
  const socketLike = new Set<ts.Node>();
  const handed = (target: ts.Type | undefined, value: ts.Expression) => {
    if (!target || !fromSocketIo(checker.getTypeAtLocation(value))) return;
    for (const symbol of symbolsOf(target)) for (const declaration of symbol.getDeclarations() ?? []) if (ownCode(declaration)) socketLike.add(declaration);
  };
  for (const source of program.getSourceFiles()) {
    if (source.fileName.includes('/node_modules/') || source.isDeclarationFile) continue;
    const mark = (node: ts.Node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) for (const argument of node.arguments ?? []) handed(checker.getContextualType(argument), argument);
      else if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) && node.initializer) handed(checker.getContextualType(node.initializer), node.initializer);
      else if (ts.isShorthandPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
        const property = checker.getContextualType(node.parent)?.getNonNullableType().getProperty(node.name.text);
        if (property) handed(checker.getTypeOfSymbolAtLocation(property, node), node.name);
      } else if (ts.isReturnStatement(node) && node.expression) handed(checker.getContextualType(node.expression), node.expression);
      ts.forEachChild(node, mark);
    };
    mark(source);
  }
  const insideSocketLike = (type: ts.Type): boolean => symbolsOf(type).some((symbol) => (symbol.getDeclarations() ?? []).some((declaration) => {
    for (let at: ts.Node | undefined = declaration; at; at = at.parent) if (socketLike.has(at)) return true;
    return false;
  }));
  const isSocket = (type: ts.Type): boolean => fromSocketIo(type) || insideSocketLike(type);

  const socketMethod = (call: ts.CallExpression): ChannelEnd['side'] | undefined => {
    if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
    const method = call.expression.name.text;
    const side = SENDS.has(method) ? 'sends' : HEARS.has(method) ? 'hears' : undefined;
    if (!side) return undefined;
    return isSocket(checker.getTypeAtLocation(call.expression.expression)) ? side : undefined;
  };

  const namesOf = (expression: ts.Expression): string[] | undefined => {
    const type = checker.getTypeAtLocation(expression);
    const parts = type.isUnion() ? type.types : [type];
    const names = parts.map((part) => (part.isStringLiteral() ? part.value : undefined));
    return names.every((name): name is string => name !== undefined) ? names : undefined;
  };

  const symbolOfFunction = (fn: ts.SignatureDeclaration): ts.Symbol | undefined => {
    if (ts.isFunctionDeclaration(fn) && fn.name) return checker.getSymbolAtLocation(fn.name);
    if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return checker.getSymbolAtLocation(fn.parent.name);
    return undefined;
  };

  const wrappers = new Map<ts.Symbol, Wrapper>();
  const calls: ts.CallExpression[] = [];
  const properties: Array<ts.PropertyAssignment | ts.ShorthandPropertyAssignment> = [];
  for (const source of program.getSourceFiles()) {
    if (source.fileName.includes('/node_modules/') || source.isDeclarationFile) continue;
    const collect = (node: ts.Node) => {
      if (ts.isCallExpression(node)) calls.push(node);
      if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ts.isObjectLiteralExpression(node.parent)) properties.push(node);
      ts.forEachChild(node, collect);
    };
    collect(source);
  }
  const calleeOf = (call: ts.CallExpression) => aliased(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression));
  const wrapperOf = (call: ts.CallExpression): Wrapper | undefined => {
    const side = socketMethod(call);
    if (side) return { side, event: 0, handler: 1 };
    const callee = calleeOf(call);
    return callee ? wrappers.get(callee) : undefined;
  };
  const parameterOf = (argument: ts.Expression | undefined): ts.ParameterDeclaration | undefined => {
    if (!argument || !ts.isIdentifier(argument)) return undefined;
    const declaration = aliased(checker.getSymbolAtLocation(argument))?.valueDeclaration;
    return declaration && ts.isParameter(declaration) ? declaration : undefined;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const call of calls) {
      const inner = wrapperOf(call);
      const parameter = inner ? parameterOf(call.arguments[inner.event]) : undefined;
      if (!inner || !parameter) continue;
      const symbol = symbolOfFunction(parameter.parent);
      if (!symbol || wrappers.has(symbol)) continue;
      const event = parameter.parent.parameters.indexOf(parameter);
      const handed = parameterOf(call.arguments[inner.handler]);
      wrappers.set(symbol, { side: inner.side, event, handler: handed ? parameter.parent.parameters.indexOf(handed) : event + 1 });
      changed = true;
    }
    for (const property of properties) {
      const value = ts.isShorthandPropertyAssignment(property) ? checker.getShorthandAssignmentValueSymbol(property) : ts.isIdentifier(property.initializer) || ts.isPropertyAccessExpression(property.initializer) ? checker.getSymbolAtLocation(ts.isPropertyAccessExpression(property.initializer) ? property.initializer.name : property.initializer) : undefined;
      const wrapper = (() => { const target = aliased(value); return target ? wrappers.get(target) : undefined; })();
      if (!wrapper) continue;
      const owner = checker.getContextualType(property.parent as ts.ObjectLiteralExpression)?.getNonNullableType();
      const wanted = owner?.getProperty(property.name.getText());
      if (!wanted || wrappers.has(wanted)) continue;
      wrappers.set(wanted, wrapper);
      changed = true;
    }
  }

  const middlewareHears = (call: ts.CallExpression): ChannelEnd[] | undefined => {
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'use') return undefined;
    if (!isSocket(checker.getTypeAtLocation(call.expression.expression))) return undefined;
    const callback = call.arguments[0];
    if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return undefined;
    const packet = callback.parameters[0]?.name;
    if (!packet || !ts.isIdentifier(packet)) return undefined;
    const packetSymbol = checker.getSymbolAtLocation(packet);
    const isFirstOfPacket = (node: ts.Expression): boolean => {
      let inner = node;
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
      return ts.isElementAccessExpression(inner) && ts.isIdentifier(inner.expression) && checker.getSymbolAtLocation(inner.expression) === packetSymbol && ts.isNumericLiteral(inner.argumentExpression) && inner.argumentExpression.text === '0';
    };
    const ends: ChannelEnd[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)) {
        const other = isFirstOfPacket(node.left) ? node.right : isFirstOfPacket(node.right) ? node.left : undefined;
        const names = other ? namesOf(other) : undefined;
        for (const name of names ?? []) if (!RESERVED.has(name)) ends.push({ kind: 'socket', name, side: 'hears', handler: callback });
      }
      ts.forEachChild(node, visit);
    };
    visit(callback.body);
    return ends;
  };

  return (call) => {
    const middleware = middlewareHears(call);
    if (middleware) return middleware;
    const side = socketMethod(call);
    if (side) {
      const event = call.arguments[0];
      if (!event) return undefined;
      const names = namesOf(event);
      if (!names) return undefined;
      return names.filter((name) => !RESERVED.has(name)).map((name) => ({ kind: 'socket', name, side, ...(side === 'hears' && call.arguments[1] ? { handler: call.arguments[1] } : {}) }));
    }
    const callee = calleeOf(call);
    const wrapper = callee ? wrappers.get(callee) : undefined;
    if (!wrapper) return undefined;
    const event = call.arguments[wrapper.event];
    const names = event ? namesOf(event) : undefined;
    if (!names) return undefined;
    const handler = call.arguments[wrapper.handler];
    return names.filter((name) => !RESERVED.has(name)).map((name) => ({ kind: 'socket', name, side: wrapper.side, ...(wrapper.side === 'hears' && handler ? { handler } : {}) }));
  };
}
