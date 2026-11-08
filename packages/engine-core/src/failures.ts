export function ignore(why: string): (failure?: unknown) => undefined {
  if (!why.trim()) throw new Error('say why the failure does not matter');
  return () => undefined;
}

export const LOST_CONNECTION: ReadonlySet<string> = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT',
  'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_CONNECT_TIMEOUT',
]);

export const causeCode = (err: unknown): string | undefined => {
  const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
};

export const streamCutOff = (err: unknown): boolean =>
  err instanceof Error && err.name === 'TypeError' && err.message === 'terminated';
