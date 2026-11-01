import { relative } from 'node:path';
import ts from 'typescript';

export interface Unit {
  id: string;
  file: string;
  name: string;
  line: number;
  column: number;
  start: number;
  end: number;
  inTest: boolean;
}

export interface Site { file: string; line: number; column: number; start: number; end: number }

export interface Edge {
  from: string;
  site: Site;
  to: string[];
  through: 'call' | 'interface';
}

export interface Unresolved { from: string; site: Site; text: string; why: string }

export interface Graph {
  units: Record<string, Unit>;
  edges: Edge[];
  unresolved: Unresolved[];
}

export interface GraphOptions {
  tsconfig: string;
  root: string;
  calledFrom: (file: string) => boolean;
}

const isTest = (file: string): boolean => /\.test\.tsx?$/.test(file) || /\/tests?\//.test(file) && !/\/src\//.test(file);
const ownCode = (file: string): boolean => !file.includes('/node_modules/') && !file.endsWith('.d.ts');

function functionName(node: ts.Node): string {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) && node.name) {
    const owner = node.parent && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent)) && node.parent.name ? `${node.parent.name.text}.` : '';
    return `${owner}${node.name.getText()}`;
  }
  if (ts.isConstructorDeclaration(node)) return `${node.parent.name?.text ?? 'class'}.constructor`;
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent)) return parent.name.getText();
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText();
  if (parent && ts.isPropertyDeclaration(parent)) return parent.name.getText();
  return '(anonymous)';
}

const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor,
]);

export function buildGraph(options: GraphOptions): Graph {
  const config = ts.getParsedCommandLineOfConfigFile(options.tsconfig, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (problem) => { throw new Error(String(problem.messageText)); } });
  if (!config) throw new Error(`${options.tsconfig} could not be read`);
  const program = ts.createProgram(config.fileNames, { ...config.options, noEmit: true });
  const checker = program.getTypeChecker();
  const units: Record<string, Unit> = {};
  const edges: Edge[] = [];
  const unresolved: Unresolved[] = [];
  const at = (file: string) => relative(options.root, file);

  const unitOf = (node: ts.Node): Unit => {
    const source = node.getSourceFile();
    const file = at(source.fileName);
    const start = node.getStart(source);
    const { line, character } = source.getLineAndCharacterOfPosition(start);
    const id = `${file}:${line + 1}:${character + 1}`;
    units[id] ??= { id, file, name: functionName(node), line: line + 1, column: character + 1, start, end: node.getEnd(), inTest: isTest(source.fileName) };
    return units[id];
  };

  const moduleUnit = (source: ts.SourceFile): Unit => {
    const file = at(source.fileName);
    const id = `${file}:module`;
    units[id] ??= { id, file, name: '(module)', line: 1, column: 1, start: 0, end: source.getEnd(), inTest: isTest(source.fileName) };
    return units[id];
  };

  const enclosing = (node: ts.Node): Unit => {
    for (let at: ts.Node | undefined = node.parent; at; at = at.parent) if (FUNCTION_KINDS.has(at.kind)) return unitOf(at);
    return moduleUnit(node.getSourceFile());
  };

  const implementations = new Map<ts.Symbol, ts.Node[]>();
  const implementationsOf = (member: ts.Declaration): ts.Node[] => {
    const owner = member.parent;
    if (!owner || !(ts.isInterfaceDeclaration(owner) || ts.isTypeLiteralNode(owner))) return [];
    const ownerSymbol = ts.isInterfaceDeclaration(owner) ? checker.getSymbolAtLocation(owner.name) : undefined;
    const name = ts.getNameOfDeclaration(member)?.getText();
    if (!ownerSymbol || !name) return [];
    const key = checker.getSymbolAtLocation(ts.getNameOfDeclaration(member)!);
    if (key && implementations.has(key)) return implementations.get(key)!;
    const found: ts.Node[] = [];
    for (const source of program.getSourceFiles()) {
      if (!ownCode(source.fileName)) continue;
      const visit = (node: ts.Node) => {
        if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.heritageClauses) {
          const implementsIt = node.heritageClauses.some((clause) => clause.types.some((type) => {
            const symbol = checker.getSymbolAtLocation(type.expression);
            const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
            return target === ownerSymbol;
          }));
          if (implementsIt) {
            for (const element of node.members) if (ts.getNameOfDeclaration(element)?.getText() === name && FUNCTION_KINDS.has(element.kind)) found.push(element);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    if (key) implementations.set(key, found);
    return found;
  };

  const siteOf = (node: ts.Node): Site => {
    const source = node.getSourceFile();
    const start = node.getStart(source);
    const { line, character } = source.getLineAndCharacterOfPosition(start);
    return { file: at(source.fileName), line: line + 1, column: character + 1, start, end: node.getEnd() };
  };

  for (const source of program.getSourceFiles()) {
    if (!ownCode(source.fileName) || !options.calledFrom(at(source.fileName))) continue;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const from = enclosing(node);
        const signature = checker.getResolvedSignature(node);
        const declaration = signature?.getDeclaration() as ts.Declaration | undefined;
        if (!declaration) {
          const callee = ts.isCallExpression(node) ? node.expression : node.expression;
          const type = checker.getTypeAtLocation(callee);
          if (type.flags & ts.TypeFlags.Any) unresolved.push({ from: from.id, site: siteOf(node), text: callee.getText().slice(0, 80), why: 'called through any' });
        } else {
          const file = declaration.getSourceFile().fileName;
          if (ownCode(file) && at(file) !== from.file) {
            if (FUNCTION_KINDS.has(declaration.kind)) {
              edges.push({ from: from.id, site: siteOf(node), to: [unitOf(declaration).id], through: 'call' });
            } else if (ts.isMethodSignature(declaration) || ts.isPropertySignature(declaration) || ts.isCallSignatureDeclaration(declaration)) {
              const real = implementationsOf(ts.isCallSignatureDeclaration(declaration) ? declaration : declaration).map(unitOf).filter((unit) => !unit.inTest);
              edges.push({ from: from.id, site: siteOf(node), to: real.map((unit) => unit.id), through: 'interface' });
            } else if (ts.isVariableDeclaration(declaration) && declaration.initializer && FUNCTION_KINDS.has(declaration.initializer.kind)) {
              edges.push({ from: from.id, site: siteOf(node), to: [unitOf(declaration.initializer).id], through: 'call' });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { units, edges, unresolved };
}
