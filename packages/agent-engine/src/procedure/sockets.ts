export const SOCKET_TYPES = [
  'text',
  'messages',
  'reply',
  'toolCalls',
  'toolResults',
  'toolSet',
  'environment',
  'memory',
  'persona',
  'modelBinding',
  'json',
  'any',
] as const;

export type SocketType = (typeof SOCKET_TYPES)[number];

export const isSocketType = (value: unknown): value is SocketType =>
  typeof value === 'string' && (SOCKET_TYPES as readonly string[]).includes(value);

export const socketAccepts = (input: SocketType, output: SocketType): boolean =>
  input === 'any' || output === 'any' || input === output;
