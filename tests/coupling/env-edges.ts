import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { parseAllDocuments } from 'yaml';
import type { ChannelEnd, ExtraEnd } from './graph.js';

const ENV_NAME = /^[A-Z][A-Z0-9_]+$/;
const HELM = join(import.meta.dirname, '..', '..', 'bin', 'helm');
const REQUIRED = ['instance.id=inst-u1', 'instance.ownerId=u1', 'instance.rootUrl=https://app.example.com', 'instance.rootPublicKeys=PEM', 'instance.credential=c', 'publicUrl=https://luno.example.com', 'storage.total=1Gi'];

export const CHART_VARIANTS: readonly string[][] = [
  REQUIRED,
  [...REQUIRED, 'routing.domain=koala.dev', 'routing.name=luno', 'mesh.loginServer=https://mesh.koala.dev', 'mesh.address=100.64.0.9'],
  [...REQUIRED, 'pool.enabled=true', 'pool.registryPullHost=127.0.0.1:31737'],
  [...REQUIRED, 'move.enabled=true'],
];

interface Rendered { kind?: string; metadata?: { name?: string }; data?: Record<string, unknown>; stringData?: Record<string, unknown>; spec?: unknown }
interface Container { image?: string; env?: Array<{ name?: string; value?: unknown }> }

function containersIn(value: unknown): Container[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(containersIn);
  const record = value as Record<string, unknown>;
  const own = ['containers', 'initContainers'].flatMap((key) => (Array.isArray(record[key]) ? record[key] as Container[] : []));
  return [...own, ...Object.entries(record).filter(([key]) => key !== 'containers' && key !== 'initContainers').flatMap(([, inner]) => containersIn(inner))];
}

export function chartEnv(root: string, chart = 'charts/instance', variants: readonly string[][] = CHART_VARIANTS, ownImage = /(^|\/)nowrinkles\/app[:@]/): ExtraEnd[] {
  const found = new Map<string, { file: string; line: number }>();
  const lineOf = (file: string, name: string): number => {
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    const at = lines.findIndex((line) => new RegExp(`^\\s*(- name: |name: )?${name}(:|\\s*$)`).test(line));
    return at >= 0 ? at + 1 : 1;
  };
  for (const variant of variants) {
    const out = execFileSync(HELM, ['template', 'coupling', join(root, chart), ...variant.flatMap((value) => ['--set', value])], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const block of out.split(/^---$/m)) {
      const source = /^# Source: [^/]+\/(.+)$/m.exec(block)?.[1];
      if (!source) continue;
      const file = `${chart}/${source}`;
      for (const document of parseAllDocuments(block)) {
        const item = document.toJS() as Rendered | null;
        if (!item) continue;
        const ours = containersIn(item.spec).filter((container) => ownImage.test(container.image ?? ''));
        const expanded = new Set(ours.flatMap((container) => (container.env ?? []).flatMap((entry) => [...String(entry.value ?? '').matchAll(/\$\(([A-Z0-9_]+)\)/g)].map((match) => match[1]!))));
        const names = [
          ...(item.kind === 'ConfigMap' && item.metadata?.name?.endsWith('-env') ? Object.keys(item.data ?? {}) : []),
          ...ours.flatMap((container) => (container.env ?? []).map((entry) => entry.name ?? '')),
        ].filter((name) => ENV_NAME.test(name) && !expanded.has(name));
        for (const name of names) if (!found.has(name)) found.set(name, { file, line: lineOf(file, name) });
      }
    }
  }
  return [...found].map(([name, at]) => ({ unit: { file: at.file, line: at.line, name: 'chart' }, kind: 'env', name, side: 'sends' }));
}

export function envChannels(program: ts.Program): (call: ts.Node) => ChannelEnd[] | undefined {
  const checker = program.getTypeChecker();
  const isEnv = (expression: ts.Expression): boolean => {
    if (expression.getText() === 'process.env') return true;
    if (!/(^|\.)env$/i.test(expression.getText())) return false;
    const type = checker.getTypeAtLocation(expression).getNonNullableType();
    return checker.getIndexInfoOfType(type, ts.IndexKind.String) !== undefined;
  };
  const aliased = (symbol: ts.Symbol | undefined) => (symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
  const literals = (expression: ts.Expression | undefined): string[] => {
    if (!expression) return [];
    const type = checker.getTypeAtLocation(expression);
    return (type.isUnion() ? type.types : [type]).flatMap((part) => (part.isStringLiteral() ? [part.value] : []));
  };

  const wrappers = new Map<ts.Symbol, number>();
  const symbolOfFunction = (fn: ts.SignatureDeclaration): ts.Symbol | undefined => {
    if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return checker.getSymbolAtLocation(fn.name);
    if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return checker.getSymbolAtLocation(fn.parent.name);
    return undefined;
  };
  const parameterOf = (expression: ts.Expression | undefined): ts.ParameterDeclaration | undefined => {
    if (!expression || !ts.isIdentifier(expression)) return undefined;
    const declaration = aliased(checker.getSymbolAtLocation(expression))?.valueDeclaration;
    return declaration && ts.isParameter(declaration) ? declaration : undefined;
  };
  const reads: ts.ElementAccessExpression[] = [];
  const calls: ts.CallExpression[] = [];
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || source.fileName.includes('/node_modules/')) continue;
    const collect = (node: ts.Node) => {
      if (ts.isElementAccessExpression(node) && isEnv(node.expression)) reads.push(node);
      if (ts.isCallExpression(node)) calls.push(node);
      ts.forEachChild(node, collect);
    };
    collect(source);
  }
  const adopt = (parameter: ts.ParameterDeclaration | undefined): boolean => {
    const symbol = parameter ? symbolOfFunction(parameter.parent) : undefined;
    if (!parameter || !symbol || wrappers.has(symbol)) return false;
    wrappers.set(symbol, parameter.parent.parameters.indexOf(parameter));
    return true;
  };
  for (const read of reads) adopt(parameterOf(read.argumentExpression));
  for (let changed = true; changed;) {
    changed = false;
    for (const call of calls) {
      const callee = aliased(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression));
      const index = callee ? wrappers.get(callee) : undefined;
      if (index !== undefined && adopt(parameterOf(call.arguments[index]))) changed = true;
    }
  }

  const ends = (names: Array<string | undefined>): ChannelEnd[] | undefined => {
    const valid = names.filter((name): name is string => name !== undefined && ENV_NAME.test(name));
    return valid.length > 0 ? valid.map((name) => ({ kind: 'env', name, side: 'hears' })) : undefined;
  };

  return (node) => {
    if (ts.isPropertyAccessExpression(node) && isEnv(node.expression)) return ends([node.name.text]);
    if (ts.isElementAccessExpression(node) && isEnv(node.expression)) return ends(literals(node.argumentExpression));
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isEnv(node.initializer)) {
      return ends(node.name.elements.map((element) => (element.propertyName ?? element.name).getText()));
    }
    if (ts.isCallExpression(node)) {
      const callee = aliased(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression));
      const index = callee ? wrappers.get(callee) : undefined;
      if (index !== undefined) return ends(literals(node.arguments[index]));
    }
    return undefined;
  };
}
