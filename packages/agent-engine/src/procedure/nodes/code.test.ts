import { describe, it, expect } from 'vitest';
import { code, codeProblems, declaredSockets } from './code.js';
import { builtInCatalogue } from './index.js';
import { definitionFor } from '../definition.js';
import { checkProcedure } from '../validate.js';
import { procedureBuilder } from '../builder/index.js';
import { procedureToBuilderCode } from '../builder/emit.js';
import { builderCodeToProcedure } from '../builder/parse.js';
import { BUILT_IN_GROUPS } from '../seeds/groups.js';

const catalogue = builtInCatalogue();

const settings = (over: Record<string, unknown> = {}) => ({
  body: 'return { total: inputs.a + inputs.b }',
  inputs: [{ name: 'a', type: 'json' }, { name: 'b', type: 'json' }],
  outputs: [{ name: 'total', type: 'json' }],
  ...over,
});

describe('the sockets a code node has are the ones its author declared', () => {
  it('reads them off the settings, in order', () => {
    expect(declaredSockets(settings(), 'inputs').map((socket) => socket.name)).toEqual(['a', 'b']);
    expect(declaredSockets(settings(), 'outputs').map((socket) => socket.name)).toEqual(['total']);
  });

  it('gives a socket that names no kind the loosest one', () => {
    expect(declaredSockets({ inputs: [{ name: 'thing' }] }, 'inputs')[0]).toMatchObject({ name: 'thing', type: 'json' });
  });

  it('writes a description for one that has none, so the canvas has something to show', () => {
    expect(declaredSockets({ outputs: [{ name: 'total' }] }, 'outputs')[0]?.describe).toContain('total');
  });

  it('leaves out anything that is not a usable name', () => {
    expect(declaredSockets({ inputs: [{ name: '2bad' }, { name: 'ok' }, 'nonsense'] }, 'inputs').map((s) => s.name))
      .toEqual(['ok']);
  });

  it('shapes the definition the rest of the engine reads', () => {
    const shaped = definitionFor(catalogue, { kind: 'code', settings: settings() });

    expect(shaped?.inputs.map((socket) => socket.name)).toEqual(['environment', 'a', 'b']);
    expect(shaped?.outputs.map((socket) => socket.name)).toEqual(['total']);
  });

  it('leaves every other kind of node exactly as the catalogue declares it', () => {
    expect(definitionFor(catalogue, { kind: 'build-context', settings: {} })).toBe(catalogue.get('build-context'));
  });
});

describe('what a code node refuses to be', () => {
  it('needs a body', () => {
    expect(codeProblems(settings({ body: '  ' }))).toContain('a code node needs a body to run');
  });

  it('has to hand something back', () => {
    expect(codeProblems(settings({ outputs: [] })))
      .toContain('a code node has to hand something back, so it needs at least one output');
  });

  it('refuses a name it could not wire', () => {
    expect(codeProblems(settings({ inputs: [{ name: 'has a space' }] })).join(' ')).toContain('is not a name');
  });

  it('refuses the same name twice', () => {
    expect(codeProblems(settings({ inputs: [{ name: 'a' }, { name: 'a' }] }))).toContain('it declares "a" twice under inputs');
  });

  it('refuses a kind of value that does not exist', () => {
    expect(codeProblems(settings({ outputs: [{ name: 'total', type: 'spreadsheet' }] })).join(' '))
      .toContain('which is not a kind of value');
  });

  it('accepts a whole one', () => {
    expect(codeProblems(settings())).toEqual([]);
  });
});

describe('a procedure with a code node in it', () => {
  const built = () => procedureBuilder({ catalogue, groups: BUILT_IN_GROUPS })({
    id: 'shaping', version: '1', name: 'Shaping', describe: 'Runs a piece of code.', budget: {},
  }, (p) => {
    const input = p.runInput('input');
    const provision = p.provisionSandbox('provision');
    const shape = p.code('shape', { environment: provision.environment, message: input.message }, {
      body: 'return { shouted: inputs.message.toUpperCase() }',
      inputs: [{ name: 'message', type: 'text' }],
      outputs: [{ name: 'shouted', type: 'text' }],
    });
    const done = p.finish('done', { result: shape.shouted! }, { outcome: 'ok' });
    const nowhere = p.finish('nowhere', { reason: provision.reason }, { outcome: 'failed' });

    p.start(provision);
    provision.on('ready', done);
    provision.on('unavailable', nowhere);
    p.layout({ input: [0, 0], provision: [0, 140], shape: [260, 0], done: [520, 0], nowhere: [520, 140] });
  }).procedure;

  it('wires into and out of the sockets its author declared', () => {
    const procedure = built();

    expect(procedure.wires).toContainEqual({ from: { node: 'input', socket: 'message' }, to: { node: 'shape', socket: 'message' } });
    expect(procedure.wires).toContainEqual({ from: { node: 'shape', socket: 'shouted' }, to: { node: 'done', socket: 'result' } });
  });

  it('checks clean', () => {
    expect(checkProcedure(built(), { catalogue, groups: BUILT_IN_GROUPS }).filter((problem) => problem.severity === 'error'))
      .toEqual([]);
  });

  it('is refused when it is wired to a socket the author never declared', () => {
    const procedure = built();
    const broken = {
      ...procedure,
      wires: [...procedure.wires, { from: { node: 'shape', socket: 'missing' }, to: { node: 'done', socket: 'reason' } }],
    };

    expect(checkProcedure(broken, { catalogue, groups: BUILT_IN_GROUPS }).map((problem) => problem.message).join(' '))
      .toContain('missing');
  });
});

describe('the node itself', () => {
  it('runs where a sandbox is, because that is where the code goes', () => {
    expect(code.definition.runs).toBe('sandbox');
  });

  it('is never treated as repeatable, because code can do anything', () => {
    expect(code.definition.idempotent).toBe(false);
  });

  it('says what it hands back when the canvas asks for a summary', () => {
    expect(code.definition.summarize(settings())).toBe('runs your code for total');
  });
});

describe('a code body written back out as builder code', () => {
  const multiline = [
    'const shouted = inputs.message.toUpperCase()',
    'return { shouted }',
  ].join('\n');

  const procedure = () => procedureBuilder({ catalogue, groups: BUILT_IN_GROUPS })({
    id: 'shaping', version: '1', name: 'Shaping', describe: 'Runs a piece of code.', budget: {},
  }, (p) => {
    const input = p.runInput('input');
    const provision = p.provisionSandbox('provision');
    const shape = p.code('shape', { environment: provision.environment, message: input.message }, {
      body: multiline,
      inputs: [{ name: 'message', type: 'text' }],
      outputs: [{ name: 'shouted', type: 'text' }],
    });
    const done = p.finish('done', { result: shape.shouted! }, { outcome: 'ok' });
    const nowhere = p.finish('nowhere', { reason: provision.reason }, { outcome: 'failed' });

    p.start(provision);
    provision.on('ready', done);
    provision.on('unavailable', nowhere);
    p.layout({ input: [0, 0], provision: [0, 140], shape: [260, 0], done: [520, 0], nowhere: [520, 140] });
  }).procedure;

  it('comes out on its own lines, as it was written, rather than one escaped string', () => {
    const written = procedureToBuilderCode(procedure(), { catalogue, groups: BUILT_IN_GROUPS });

    expect(written).toContain('const shouted = inputs.message.toUpperCase()');
    expect(written).not.toContain('\\n');
  });

  it('reads back as exactly the same body', () => {
    const written = procedureToBuilderCode(procedure(), { catalogue, groups: BUILT_IN_GROUPS });
    const read = builderCodeToProcedure(written, { catalogue, groups: BUILT_IN_GROUPS });

    expect(read.ok).toBe(true);
    expect(read.ok && read.procedure.nodes.find((node) => node.id === 'shape')?.settings.body).toBe(multiline);
  });

  it('refuses builder code that would have to be evaluated to know what the body even is', () => {
    const written = procedureToBuilderCode(procedure(), { catalogue, groups: BUILT_IN_GROUPS })
      .replace('const shouted = inputs.message.toUpperCase()', 'const shouted = ${process.env.SECRET}');
    const read = builderCodeToProcedure(written, { catalogue, groups: BUILT_IN_GROUPS });

    expect(read.ok, 'reading a procedure must never run anything, and an interpolation would').toBe(false);
  });

  it('stores a body that reads the environment, because what the body may do is the sandbox\'s business, not the parser\'s', () => {
    const reading = procedureBuilder({ catalogue, groups: BUILT_IN_GROUPS })({
      id: 'peeking', version: '1', name: 'Peeking', describe: 'Reads an environment variable.', budget: {},
    }, (p) => {
      const provision = p.provisionSandbox('provision');
      const peek = p.code('peek', { environment: provision.environment }, {
        body: 'return { seen: process.env.HOME }',
        inputs: [],
        outputs: [{ name: 'seen', type: 'text' }],
      });
      const done = p.finish('done', { result: peek.seen! }, { outcome: 'ok' });
      const nowhere = p.finish('nowhere', { reason: provision.reason }, { outcome: 'failed' });

      p.start(provision);
      provision.on('ready', done);
      provision.on('unavailable', nowhere);
      p.layout({ provision: [0, 0], peek: [260, 0], done: [520, 0], nowhere: [520, 140] });
    }).procedure;

    const read = builderCodeToProcedure(procedureToBuilderCode(reading, { catalogue, groups: BUILT_IN_GROUPS }), { catalogue, groups: BUILT_IN_GROUPS });

    expect(read.ok).toBe(true);
    expect(read.ok && read.procedure.nodes.find((node) => node.id === 'peek')?.settings.body).toBe('return { seen: process.env.HOME }');
  });
});

describe('the workspace a code node runs in', () => {
  it('is a socket every code node has, whatever its author declared', () => {
    const shaped = definitionFor(catalogue, { kind: 'code', settings: settings({ inputs: [] }) });

    expect(shaped?.inputs[0]).toMatchObject({ name: 'environment', type: 'environment', required: true });
  });

  it('cannot be declared a second time under another kind', () => {
    expect(codeProblems(settings({ inputs: [{ name: 'environment', type: 'text' }] })).join(' '))
      .toContain('cannot be declared again');
  });
});
