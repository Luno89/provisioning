import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const exported = (node: ts.Node): boolean => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
const isDefault = (node: ts.Node): boolean => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);

export function exportsIn(source: string, file: string): Set<string> {
  const names = new Set<string>();
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  for (const statement of tree.statements) {
    if (ts.isExportAssignment(statement)) names.add('default');
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add(element.name.text);
    }
    if (!exported(statement)) continue;
    if (isDefault(statement)) {
      names.add('default');
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.add(statement.name.text);
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name && !isDefault(statement)) names.add(statement.name.text);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
    }
  }
  return names;
}

export const exportsOfFile = (root: string) => (file: string): Set<string> => exportsIn(readFileSync(join(root, file), 'utf8'), file);
