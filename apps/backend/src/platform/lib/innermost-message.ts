export function innermostMessage(err: unknown, otherwise: string): string {
  let said = otherwise;
  for (let at = err as { message?: string; cause?: unknown } | undefined; at; at = at.cause as typeof at) {
    if (typeof at.message === 'string' && at.message) said = at.message;
  }
  return said;
}
