import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { builtInCatalogue } from '../nodes/index.js';
import { BUILT_IN_GROUPS, MODEL_TURN } from '../seeds/groups.js';
import { BUILT_IN_PROCEDURES, SINGLE_SHOT_V2 } from '../seeds/procedures.js';
import { procedureToBuilderCode } from './emit.js';
import { generatedBuilderFiles } from './generated-files.js';
import { BUILDER_DECLARATIONS } from './declarations.generated.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const options = { catalogue: builtInCatalogue(), groups: BUILT_IN_GROUPS };

function typeErrors(code: string): string[] {
  const files: Record<string, string> = { '/builder.d.ts': BUILDER_DECLARATIONS, '/procedure.ts': code };
  const compilerOptions: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ['lib.es2022.d.ts'], types: [] };
  const host = ts.createCompilerHost(compilerOptions);
  const original = { getSourceFile: host.getSourceFile, fileExists: host.fileExists, readFile: host.readFile };
  host.getSourceFile = (name, version) => (files[name] !== undefined ? ts.createSourceFile(name, files[name]!, version) : original.getSourceFile.call(host, name, version));
  host.fileExists = (name) => files[name] !== undefined || original.fileExists.call(host, name);
  host.readFile = (name) => files[name] ?? original.readFile.call(host, name);
  const program = ts.createProgram(['/builder.d.ts', '/procedure.ts'], compilerOptions, host);
  return ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === '/procedure.ts' || diagnostic.file?.fileName === '/builder.d.ts')
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

describe('the generated builder types', () => {
  it('are up to date with the node definitions — run npm run gen:builder -w packages/agent-engine if not', () => {
    for (const [path, content] of Object.entries(generatedBuilderFiles())) {
      expect(readFileSync(resolve(packageRoot, path), 'utf8'), path).toBe(content);
    }
  });

  it.each(BUILT_IN_PROCEDURES.map((procedure) => [procedure.id, procedure] as const))('accept the builder code written for %s', (_id, procedure) => {
    expect(typeErrors(procedureToBuilderCode(procedure, options))).toEqual([]);
  });

  it('accept a procedure that defines and uses its own group', () => {
    const own = {
      ...SINGLE_SHOT_V2,
      groups: [{ ...MODEL_TURN, id: 'my-turn' }],
      nodes: [...SINGLE_SHOT_V2.nodes, { id: 'turn', kind: 'group', group: 'my-turn', settings: {}, position: { x: 0, y: 0 } }],
      wires: [...SINGLE_SHOT_V2.wires, { from: { node: 'conversation', socket: 'messages' }, to: { node: 'turn', socket: 'messages' } }],
    };
    expect(typeErrors(procedureToBuilderCode(own, options))).toEqual([]);
  });

  const snippet = (body: string) => `import { procedure } from '@koala/procedure-builder'
export default procedure({ id: 'x' }, (p) => {
  const persona = p.persona('persona')
  const done = p.finish('done', {}, { outcome: 'ok' })
${body}
  p.start(done)
})
`;

  it('catch a wrong exit name, a wire between sockets that carry different things, and a missing required setting', () => {
    expect(typeErrors(snippet("  const call = p.callModel('call')\n  call.on('toolcall', done)")).join('\n')).toContain('"toolcall"');
    expect(typeErrors(snippet("  const call = p.callModel('call', { system: persona.persona })")).join('\n')).toContain('Out<"persona">');
    expect(typeErrors(snippet("  const other = p.finish('other')")).length).toBeGreaterThan(0);
    expect(typeErrors(snippet("  const context = p.buildContext('context', { sections: [persona.prompt] })"))).toEqual([]);
  });
});
