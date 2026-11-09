import axios from 'axios';
import { getGlobalDispatcher } from 'undici';
import { describe, expect, it } from 'vitest';
import { useDependencyHttp } from '@koala/engine-core/http';
import { useOneHttpClient } from './dependencies.js';

describe('one HTTP client per process', () => {
  it('gives fetch and axios the layer\'s client, with its connect limit and no limit on the answer', () => {
    useOneHttpClient();
    const layer = useDependencyHttp();
    expect(getGlobalDispatcher()).toBe(layer.dispatcher);
    expect(axios.defaults.httpAgent).toBe(layer.httpAgent);
    expect(axios.defaults.httpsAgent).toBe(layer.httpsAgent);
    expect(axios.defaults.timeout ?? 0).toBe(0);
  });
});
