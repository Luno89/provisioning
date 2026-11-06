import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';

export type ReferenceKind = 'declaration' | 'import' | 'write' | 'read';

export interface Reference {
  file: string;
  line: number;
  column: number;
  kind: ReferenceKind;
  text: string;
}

const parsed = (tsconfig: string): ts.ParsedCommandLine => {
  const config = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (problem) => { throw new Error(ts.flattenDiagnosticMessageText(problem.messageText, '\n')); } });
  if (!config) throw new Error(`${tsconfig} could not be read`);
  return config;
};

const serviceFor = (config: ts.ParsedCommandLine): ts.LanguageService => {
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => config.fileNames,
    getScriptVersion: () => '0',
    getScriptSnapshot: (file) => (ts.sys.fileExists(file) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(file) ?? '') : undefined),
    getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
    getCompilationSettings: () => config.options,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  return ts.createLanguageService(host, ts.createDocumentRegistry());
};

const declaredName = (node: ts.Node): ts.Node | undefined => {
  const named = node as ts.Node & { name?: ts.Node };
  return named.name && (ts.isIdentifier(named.name) || ts.isStringLiteral(named.name) || ts.isPrivateIdentifier(named.name)) ? named.name : undefined;
};

const nameOf = (node: ts.Node): string | undefined => {
  const name = declaredName(node);
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) ? name.text : undefined;
};

export function declarationsNamed(source: ts.SourceFile, symbol: string): number[] {
  const path = symbol.split('.');
  const found: number[] = [];
  const visit = (node: ts.Node, depth: number) => {
    const name = nameOf(node);
    if (name === path[depth]) {
      if (depth === path.length - 1) {
        const at = declaredName(node)!;
        found.push(at.getStart(source));
        return;
      }
      ts.forEachChild(node, (child) => visit(child, depth + 1));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, depth));
  };
  visit(source, 0);
  return found;
}

const POSITION = /^(\d+):(\d+)$/;

function positionsOf(source: ts.SourceFile, symbol: string): number[] {
  const place = POSITION.exec(symbol);
  return place ? [source.getPositionOfLineAndCharacter(Number(place[1]) - 1, Number(place[2]) - 1)] : declarationsNamed(source, symbol);
}

function nodeAt(source: ts.SourceFile, position: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (position < node.getStart(source) || position >= node.getEnd()) return;
    found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const imports = (node: ts.Node | undefined): boolean =>
  Boolean(node?.parent && (ts.isImportSpecifier(node.parent) || ts.isExportSpecifier(node.parent) || ts.isImportClause(node.parent) || ts.isNamespaceImport(node.parent)));

const lineText = (file: string, line: number, cache: Map<string, string[]>): string => {
  let lines = cache.get(file);
  if (!lines) {
    lines = readFileSync(file, 'utf8').split('\n');
    cache.set(file, lines);
  }
  return (lines[line] ?? '').trim();
};

export function referencesOf(root: string, tsconfigs: readonly string[], file: string, symbol: string): Reference[] {
  const target = resolve(root, file);
  const found = new Map<string, Reference>();
  const lines = new Map<string, string[]>();
  let declared = false;
  for (const tsconfig of tsconfigs) {
    const config = parsed(resolve(root, tsconfig));
    const service = serviceFor(config);
    const program = service.getProgram();
    const source = program?.getSourceFile(target);
    if (!program || !source) continue;
    const positions = positionsOf(source, symbol);
    if (positions.length === 0) continue;
    declared = true;
    for (const position of positions) {
      for (const group of service.findReferences(target, position) ?? []) {
        for (const entry of group.references) {
          const at = program.getSourceFile(entry.fileName);
          if (!at) continue;
          const where = at.getLineAndCharacterOfPosition(entry.textSpan.start);
          const kind: ReferenceKind = entry.isDefinition ? 'declaration' : imports(nodeAt(at, entry.textSpan.start)) ? 'import' : entry.isWriteAccess ? 'write' : 'read';
          const name = relative(root, entry.fileName);
          const key = `${name}:${entry.textSpan.start}`;
          const seen = found.get(key);
          if (!seen || (seen.kind === 'read' && kind !== 'read')) {
            found.set(key, { file: name, line: where.line + 1, column: where.character + 1, kind, text: lineText(entry.fileName, where.line, lines) });
          }
        }
      }
    }
  }
  if (!declared) throw new Error(`no declaration of ${symbol} in ${file} in any of ${tsconfigs.join(', ')}`);
  return [...found.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
}
