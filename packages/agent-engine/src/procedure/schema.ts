import type { RunBudget } from '../runtime/run.js';
import type { SocketType } from './sockets.js';

export const PROCEDURE_SCHEMA = 2 as const;

export type NodeId = string;

export interface Position {
  x: number;
  y: number;
}

export interface PlacedNode {
  id: NodeId;
  kind: string;
  group?: string | undefined;
  label?: string | undefined;
  notes?: string | undefined;
  settings: Record<string, unknown>;
  position: Position;
}

export interface SocketRef {
  node: NodeId;
  socket: string;
}

export interface Wire {
  from: SocketRef;
  to: SocketRef;
}

export interface Flow {
  from: NodeId;
  exit: string;
  to: NodeId;
}

export interface Body {
  start: NodeId;
  nodes: PlacedNode[];
  wires: Wire[];
  flow: Flow[];
}

export interface GroupSocket {
  name: string;
  type: SocketType;
  describe: string;
  required?: boolean | undefined;
  many?: boolean | undefined;
}

export interface GroupInput extends GroupSocket {
  to: SocketRef[];
}

export interface GroupOutput extends GroupSocket {
  from: SocketRef;
}

export interface GroupExit {
  name: string;
  describe: string;
  from: { node: NodeId; exit: string };
}

export interface GroupDefinition extends Body {
  id: string;
  title: string;
  describe: string;
  inputs: GroupInput[];
  outputs: GroupOutput[];
  exits: GroupExit[];
}

export interface Procedure extends Body {
  schema: typeof PROCEDURE_SCHEMA;
  id: string;
  version: string;
  name: string;
  describe: string;
  budget: RunBudget;
  cleanup?: NodeId | undefined;
  groups: GroupDefinition[];
}

export const isGroupInstance = (node: PlacedNode): node is PlacedNode & { group: string } =>
  typeof node.group === 'string';
