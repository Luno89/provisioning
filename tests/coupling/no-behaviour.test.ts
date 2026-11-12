import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { onlyLogs } from './no-behaviour.js';

const fn = (text: string): ts.Node => {
  const source = ts.createSourceFile('x.ts', `const f = ${text};`, ts.ScriptTarget.Latest, true);
  let found: ts.Node | undefined;
  const walk = (node: ts.Node) => { if (!found && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) found = node; ts.forEachChild(node, walk); };
  walk(source);
  return found!;
};

describe('a function whose only effect is a log line', () => {
  it('is one that writes to the console or appends to a log file, however it is guarded', () => {
    expect(onlyLogs(fn('(line) => console.warn(`[HubSync] ${line}`)'))).toBe(true);
    expect(onlyLogs(fn('(line) => { console.log(line); console.error(line); }'))).toBe(true);
    expect(onlyLogs(fn('(line) => (args.logFile ? fsp.appendFile(args.logFile, line).catch(ignore("progress only")) : Promise.resolve())'))).toBe(true);
  });

  it('is not one that does anything else as well', () => {
    expect(onlyLogs(fn('(line) => { console.warn(line); save(line); }'))).toBe(false);
    expect(onlyLogs(fn('(line) => store.append(line)'))).toBe(false);
    expect(onlyLogs(fn('(line) => fsp.writeFile(path, line)'))).toBe(false);
    expect(onlyLogs(fn('() => { if (ready) console.log("x"); }'))).toBe(false);
  });
});
