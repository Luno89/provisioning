import { describe, expect, it } from 'vitest';
import { podPlaceFrom, stillRoutedTo } from './drain.js';

describe('whether a service still sends new connections to a pod', () => {
  const slice = (addresses: string[], ready?: boolean | null) => ({ endpoints: [{ addresses, ...(ready === undefined ? {} : { conditions: { ready } }) }] });

  it('is so while any slice lists the pod ready, or says nothing of its readiness', () => {
    expect(stillRoutedTo({ items: [slice(['10.42.0.9'], true)] }, '10.42.0.9')).toBe(true);
    expect(stillRoutedTo({ items: [slice(['10.42.0.9'], null)] }, '10.42.0.9')).toBe(true);
    expect(stillRoutedTo({ items: [slice(['10.42.0.9'])] }, '10.42.0.9')).toBe(true);
    expect(stillRoutedTo({ items: [slice(['10.42.0.7'], true), slice(['10.42.0.9'], false), slice(['10.42.0.9'], true)] }, '10.42.0.9')).toBe(true);
  });

  it('stops once every slice has it not ready or has let it go', () => {
    expect(stillRoutedTo({ items: [slice(['10.42.0.9'], false), slice(['10.42.0.7'], true)] }, '10.42.0.9')).toBe(false);
    expect(stillRoutedTo({ items: [{ endpoints: null }, {}] }, '10.42.0.9')).toBe(false);
    expect(stillRoutedTo({}, '10.42.0.9')).toBe(false);
  });

  it('waits, once the pod is not ready, while its service has only a replacement still coming up, since kube-proxy then sends to the leaving pod', () => {
    const service = (...endpoints: { addresses: string[]; conditions: { ready: boolean; terminating?: boolean } }[]) => ({ items: [{ endpoints }] });
    const leaving = { addresses: ['10.42.0.9'], conditions: { ready: false, terminating: true } };
    expect(stillRoutedTo(service(leaving, { addresses: ['10.42.0.7'], conditions: { ready: false } }), '10.42.0.9')).toBe(true);
    expect(stillRoutedTo(service(leaving, { addresses: ['10.42.0.7'], conditions: { ready: true } }), '10.42.0.9')).toBe(false);
    expect(stillRoutedTo(service(leaving), '10.42.0.9')).toBe(false);
    expect(stillRoutedTo(service(leaving, { addresses: ['10.42.0.5'], conditions: { ready: false, terminating: true } }), '10.42.0.9')).toBe(false);
  });

  it('knows the pod only when Kubernetes said both its address and its namespace', () => {
    expect(podPlaceFrom({ POD_IP: '10.42.0.9', POD_NAMESPACE: 'nowrinkles' })).toEqual({ ip: '10.42.0.9', namespace: 'nowrinkles' });
    expect(podPlaceFrom({ POD_IP: '10.42.0.9' })).toBeUndefined();
    expect(podPlaceFrom({})).toBeUndefined();
  });
});
