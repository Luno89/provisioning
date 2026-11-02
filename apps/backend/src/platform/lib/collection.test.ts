import { describe, expect, it } from 'vitest';
import { clientOptionsFor, connectsDirectly } from './collection.js';

describe('how Koala connects to its Mongo', () => {
  it('connects straight to the one server a URI names, whatever address that server knows itself by', () => {
    expect(connectsDirectly('mongodb://admin:p%2Fw@127.0.0.1:27017/provisioning?authSource=admin')).toBe(true);
    expect(connectsDirectly('mongodb://koala-mongo:27017/provisioning')).toBe(true);
    expect(clientOptionsFor('mongodb://127.0.0.1:27017/')).toEqual({ ignoreUndefined: true, directConnection: true });
  });

  it('leaves discovery to the driver when the URI names several servers, a set, or how to connect', () => {
    expect(connectsDirectly('mongodb://a:27017,b:27017/provisioning')).toBe(false);
    expect(connectsDirectly('mongodb://127.0.0.1:27017/?replicaSet=rs0')).toBe(false);
    expect(connectsDirectly('mongodb://127.0.0.1:27017/?directConnection=false')).toBe(false);
    expect(connectsDirectly('mongodb+srv://cluster.example.com/provisioning')).toBe(false);
    expect(clientOptionsFor('mongodb://a:27017,b:27017/')).toEqual({ ignoreUndefined: true });
  });
});
