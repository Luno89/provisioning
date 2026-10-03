import { defineNode, type ExitSpec, type NodeDefinition, type SocketSpec } from './definition.js';
import type { GroupSetting } from './settings-schema.js';
import type { BudgetSpend } from '../runtime/run.js';
import { isSocketType } from './sockets.js';
import { textOf } from './nodes/read.js';

export const HOST_OP_KIND = 'host-op';

export interface HostOperation {
  name: string;
  title: string;
  group: string;
  describe: string;
  inputs: readonly SocketSpec[];
  outputs: readonly SocketSpec[];
  exits: readonly ExitSpec[];
  settings: GroupSetting;
  summary: string;
  idempotent: boolean;
  spends?: readonly BudgetSpend[] | undefined;
}

const OPERATION_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const SOCKET_NAME = /^[a-zA-Z][a-zA-Z0-9]*$/;

export function operationProblems(operation: HostOperation): string[] {
  const problems: string[] = [];
  const say = (message: string) => problems.push(`operation "${operation.name}" ${message}`);
  if (!OPERATION_NAME.test(operation.name)) say('has a name that is not lower-case words joined by dots and dashes');
  if (!operation.title.trim()) say('has no title');
  if (!operation.describe.trim()) say('does not say what it does');
  if (operation.exits.length === 0) say('has no exits, so nothing can follow it');
  for (const socket of [...operation.inputs, ...operation.outputs]) {
    if (!SOCKET_NAME.test(socket.name)) say(`has a socket called "${socket.name}", which is not a socket name`);
    if (!isSocketType(socket.type)) say(`has a socket "${socket.name}" of type "${String(socket.type)}", which is not a kind of value`);
  }
  if ('operation' in operation.settings.properties) say('declares a setting called "operation", which names the operation itself');
  return problems;
}

export function fillSummary(template: string, settings: Readonly<Record<string, unknown>>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    const value = settings[key];
    if (value === undefined || value === null || value === '') return '—';
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
  });
}

export function hostOpNode(operations: readonly HostOperation[]): NodeDefinition {
  const byName = new Map(operations.map((operation) => [operation.name, operation]));
  const named = (settings: Readonly<Record<string, unknown>>) => byName.get(textOf(settings, 'operation'));

  return defineNode({
    kind: HOST_OP_KIND,
    title: 'Platform Operation',
    category: 'host',
    describe: 'Runs one operation the platform provides — real code on the engine worker, with no model involved. Which operation decides its sockets, exits and settings.',
    role: 'step',
    inputs: [],
    outputs: [],
    exits: [{ name: 'done', describe: 'The operation finished.' }],
    settings: {
      type: 'object',
      required: ['operation'],
      properties: { operation: { type: 'string', title: 'Operation', enum: operations.map((operation) => operation.name), minLength: 1 } },
    },
    runs: 'activity',
    idempotent: false,
    summarize: (settings) => {
      const operation = named(settings);
      return operation ? fillSummary(operation.summary, settings) : `runs ${textOf(settings, 'operation') || 'a platform operation'}`;
    },
    check: (settings) => (named(settings) ? [] : [`"${textOf(settings, 'operation')}" is not an operation this platform offers`]),
    resolve: (settings) => {
      const operation = named(settings);
      if (!operation) return undefined;
      return {
        title: operation.title,
        describe: operation.describe,
        inputs: operation.inputs,
        outputs: operation.outputs,
        exits: operation.exits,
        idempotent: operation.idempotent,
        ...(operation.spends ? { spends: operation.spends } : {}),
        settings: {
          ...operation.settings,
          required: ['operation', ...(operation.settings.required ?? [])],
          properties: { operation: { type: 'string', title: 'Operation', enum: [operation.name] }, ...operation.settings.properties },
        },
        summarize: (shaped) => fillSummary(operation.summary, shaped),
      };
    },
  });
}
