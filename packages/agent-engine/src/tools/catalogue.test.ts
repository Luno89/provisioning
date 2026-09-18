import { describe, it, expect } from 'vitest';
import { asContract, checkCatalogue, checkDefinition, contractsFor, type ToolDefinition } from './catalogue.js';
import { BUILDER_TOOLS } from './builder-tools-catalogue.js';

const tool = (over: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name: 'do_thing',
  summary: 'Does the thing',
  binding: 'platform',
  effect: 'write',
  status: 'draft',
  returns: 'Confirmation that the thing was done',
  failures: [{ when: 'the target does not exist', says: 'there is no such target' }],
  parameters: {
    type: 'object',
    properties: { target: { type: 'string', description: 'What to do it to' } },
    required: ['target'],
  },
  ...over,
});

const complaints = (definition: ToolDefinition) =>
  checkDefinition(definition).map((problem) => problem.message);

describe('what a tool definition must carry', () => {
  it('accepts a complete one', () => {
    expect(checkDefinition(tool())).toEqual([]);
  });

  it('refuses an argument with no description, since that is what the model reads', () => {
    const thin = tool({
      parameters: { type: 'object', properties: { target: { type: 'string', description: '' } } },
    });

    expect(complaints(thin)).toContain('argument "target" has no description');
  });

  it('refuses a required argument it never defines', () => {
    const wrong = tool({
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', description: 'x' } },
        required: ['target', 'ghost'],
      },
    });

    expect(complaints(wrong)).toContain('requires "ghost", which it does not define');
  });

  it('refuses a summary that tells the model nothing', () => {
    expect(complaints(tool({ summary: '   ' })))
      .toContain('has no summary, so nothing tells the model what it does');
  });

  it('refuses a name a model cannot call', () => {
    expect(complaints(tool({ name: 'Do Thing' }))).toHaveLength(1);
    expect(complaints(tool({ name: 'read_file' }))).toEqual([]);
  });

  it('refuses installing on a tool that never runs in the workspace', () => {
    expect(complaints(tool({ binding: 'platform', needsBinaries: ['psql'] })))
      .toContain('only an environment-bound tool runs inside the workspace, so only it can need installing');
  });

  it('refuses a binary with no way to install it', () => {
    expect(complaints(tool({ binding: 'environment', needsBinaries: ['psql'] })))
      .toContain('needs psql but does not say how to install it');

    expect(complaints(tool({
      binding: 'environment',
      needsBinaries: ['psql'],
      install: { via: 'dnf', packages: ['postgresql'] },
    }))).toEqual([]);
  });

  it('refuses a tool that never says what it returns', () => {
    expect(complaints(tool({ returns: '  ' })))
      .toContain('does not say what it returns, so the model cannot plan past it');
  });

  it('refuses a tool that documents no way of failing', () => {
    expect(complaints(tool({ failures: [] })).join(' ')).toContain('lists no failures');
  });

  it('refuses an approval with nobody behind it', () => {
    expect(complaints(tool({ status: 'approved' })))
      .toContain('is marked approved but nobody is recorded as approving it');

    expect(complaints(tool({ status: 'approved', approvedBy: 'luno' }))).toEqual([]);
  });

  it('catches the same tool defined twice', () => {
    expect(checkCatalogue([tool(), tool()]).map((p) => p.message)).toContain('is defined twice');
  });
});

describe('what reaches an agent', () => {
  it('offers nothing that has not been approved', () => {
    expect(contractsFor([tool({ status: 'draft' })])).toEqual([]);
  });

  it('offers a draft only when asked for explicitly, which is what the harness does', () => {
    expect(contractsFor([tool()], ['draft', 'approved']).map((c) => c.name)).toEqual(['do_thing']);
  });

  it('carries the schema through, because that is the part that kept going missing', () => {
    const contract = asContract(tool());

    expect(contract.parameters).toMatchObject({
      properties: { target: { description: 'What to do it to' } },
      required: ['target'],
    });
  });
});

describe('the catalogue as it stands', () => {
  it('is internally consistent', () => {
    expect(checkCatalogue(BUILDER_TOOLS)).toEqual([]);
  });

  it('has nothing approved yet, because nothing has been reviewed', () => {
    expect(BUILDER_TOOLS.filter((entry) => entry.status === 'approved')).toEqual([]);
  });

  it('gives every tool a parameter schema, with no way to define one without', () => {
    for (const entry of BUILDER_TOOLS.filter((tool) => tool.name !== 'list_references')) {
      expect(Object.keys(entry.parameters.properties).length).toBeGreaterThan(0);
    }
  });
});
