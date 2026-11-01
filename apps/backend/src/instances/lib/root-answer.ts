export interface RootAnswer {
  body: unknown;
  error: string | undefined;
}

const errorIn = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object' || !('error' in body)) return undefined;
  return typeof body.error === 'string' ? body.error : undefined;
};

export function rootAnswer(ok: boolean, status: number, text: string): RootAnswer {
  if (!text.trim()) return { body: {}, error: undefined };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    if (ok) throw new Error(`root answered ${status} with something that is not JSON: ${text.trim().slice(0, 200)}`);
    return { body: {}, error: undefined };
  }
  return { body, error: errorIn(body) };
}
