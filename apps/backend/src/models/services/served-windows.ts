import { ignore } from '@koala/engine-core/failures';
import type { ModelKind } from '../lib/model-registry.js';
import { servedWindowFrom, servedWindowPath } from '../lib/served-window.js';

export interface WindowAsk {
  baseUrl: string;
  kind?: ModelKind | undefined;
  model: string;
  apiKey?: string | undefined;
}

export interface ServedWindows {
  read(ask: WindowAsk): Promise<number | undefined>;
}

export const servedWindowsOverHttp = (): ServedWindows => ({
  async read({ baseUrl, kind, model, apiKey }) {
    const answer = await fetch(`${baseUrl}${servedWindowPath(kind)}`, {
      headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    }).catch(ignore('a server that cannot be asked its window is reached by the model call next, which waits for it or fails with why'));
    if (!answer?.ok) return undefined;
    const body: unknown = await answer.json().catch(ignore('an answer that is not JSON names no window'));
    return servedWindowFrom(kind, body, model);
  },
});
