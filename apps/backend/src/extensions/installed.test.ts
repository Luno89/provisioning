import { describe, it, expect } from 'vitest';
import { extensionProblems } from '@koala/agent-engine/procedure';
import { INSTALLED_EXTENSIONS } from './installed.js';
import { engineOwn } from './seeds.js';
import { extensionRuntimes, operationHandlers, unhandledOperations } from './runtime.js';

describe('the installed extensions', () => {
  it('check clean against each other and against what the engine itself offers', () => {
    const own = engineOwn();
    expect(extensionProblems(INSTALLED_EXTENSIONS, { tools: own.tools, personas: own.personas, procedures: own.procedures })).toEqual([]);
  });

  it('have a handler on the worker for every operation they declare', () => {
    const handlers = operationHandlers(extensionRuntimes({ platform: { operations: {} as never }, grove: { operations: {} as never } }));
    expect(unhandledOperations(handlers)).toEqual([]);
  });
});
