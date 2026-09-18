import { describe, it, expect } from 'vitest';
import { defaultSettings, settingsProblems, type GroupSetting } from './settings-schema.js';

const schema: GroupSetting = {
  type: 'object',
  required: ['scope'],
  properties: {
    scope: { type: 'string', enum: ['project', 'global'], default: 'project' },
    label: { type: 'string', minLength: 2, maxLength: 5 },
    maxChars: { type: 'integer', minimum: 100, maximum: 8000, default: 4000 },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    think: { type: 'boolean', default: false },
    tools: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 2, default: [] },
    limits: {
      type: 'object',
      properties: { rounds: { type: 'integer', minimum: 1, default: 3 } },
    },
  },
};

describe('settings problems', () => {
  it('finds nothing wrong with settings that fit', () => {
    expect(settingsProblems(schema, {
      scope: 'global',
      label: 'ok',
      maxChars: 500,
      temperature: 0.5,
      think: true,
      tools: ['read_file'],
      limits: { rounds: 2 },
    })).toEqual([]);
  });

  it('names the setting and what is wrong with it', () => {
    expect(settingsProblems(schema, {
      scope: 'everywhere',
      label: 'x',
      maxChars: 50.5,
      temperature: 3,
      think: 'yes',
      tools: ['a', '', 'c'],
      limits: { rounds: 0 },
    })).toEqual([
      'settings.scope has to be one of "project", "global", not "everywhere"',
      'settings.label has to be at least 2 characters',
      'settings.maxChars has to be a whole number',
      'settings.temperature can be at most 2',
      'settings.think has to be true or false',
      'settings.tools can have at most 2 entries',
      'settings.limits.rounds has to be at least 1',
    ]);
  });

  it('reports a missing required setting and one the node does not have', () => {
    expect(settingsProblems(schema, { colour: 'red' })).toEqual([
      'settings.scope is required',
      'settings has no setting called "colour"',
    ]);
  });

  it('points into a list at the entry that is wrong', () => {
    expect(settingsProblems(schema, { scope: 'project', tools: ['a', ''] })).toEqual([
      'settings.tools[1] has to be at least 1 characters',
    ]);
  });

  it('refuses something that is not a set of named values at all', () => {
    expect(settingsProblems(schema, ['scope'])).toEqual(['settings has to be a set of named values']);
  });
});

describe('default settings', () => {
  it('fills every default, including inside nested settings', () => {
    expect(defaultSettings(schema)).toEqual({
      scope: 'project',
      maxChars: 4000,
      think: false,
      tools: [],
      limits: { rounds: 3 },
    });
  });

  it('hands out copies, so editing one node does not change the next', () => {
    const first = defaultSettings(schema);
    (first.tools as string[]).push('read_file');

    expect(defaultSettings(schema).tools).toEqual([]);
  });

  it('fits the schema it came from', () => {
    expect(settingsProblems(schema, defaultSettings(schema))).toEqual([]);
  });
});
