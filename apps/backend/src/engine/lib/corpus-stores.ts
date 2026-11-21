import type { Reaching } from '../../platform/index.js';

export const refusal = (who: string, res: Response, said: string): Error => {
  const retryAfter = res.headers.get('retry-after');
  const shown = said.slice(0, 300);
  return Object.assign(new Error(`${who} refused: HTTP ${res.status}${shown ? ` ${shown}` : ''}`), { response: { status: res.status, headers: retryAfter ? { 'retry-after': retryAfter } : {} } });
};

export async function bothOf<A, B>(a: Promise<A>, b: Promise<B>): Promise<[A, B]> {
  const [first, second] = await Promise.allSettled([a, b]);
  if (first.status === 'rejected') throw first.reason;
  if (second.status === 'rejected') throw second.reason;
  return [first.value, second.value];
}

export async function answered(res: Response, who: string, reach: Pick<Reaching, 'failed'>): Promise<unknown> {
  if (!res.ok) throw reach.failed(refusal(who, res, await res.text()));
  const text = await res.text();
  return text ? JSON.parse(text) as unknown : {};
}
