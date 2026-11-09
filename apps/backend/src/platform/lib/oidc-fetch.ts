import * as client from 'openid-client';

const fetchNow: typeof fetch = (input, init) => globalThis.fetch(input, init);

export const answerUnlimited = (doFetch: typeof fetch = fetchNow): client.CustomFetch =>
  (url, options) => {
    const { signal: _theirLimit, ...rest } = options;
    return doFetch(url, rest as RequestInit);
  };

export const withAnswerUnlimited = (doFetch: typeof fetch = fetchNow) => ({ [client.customFetch]: answerUnlimited(doFetch) });
