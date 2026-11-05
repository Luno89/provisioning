import { uncompress, compress } from 'snappyjs';
import { describe, expect, it, vi } from 'vitest';
import type { ClusterMetadata } from '../../platform/lib/types.js';
import { newMetricsToken } from '../lib/machine-metrics.js';
import { MachineMetricsRelay } from './MachineMetricsRelay.js';

const label = (name: string, value: string) => {
  const field = (number: number, text: string) => Buffer.concat([Buffer.from([number * 8 + 2, text.length]), Buffer.from(text)]);
  const body = Buffer.concat([field(1, name), field(2, value)]);
  return Buffer.concat([Buffer.from([10, body.length]), body]);
};
const series = (...labels: Buffer[]) => { const body = Buffer.concat(labels); return Buffer.concat([Buffer.from([10, body.length]), body]); };

const { token, hash } = newMetricsToken();
const clusters = [
  { id: 'machine-desk', provider: 'machine', metricsTokenHash: hash },
  { id: 'machine-other', provider: 'machine' },
  { id: 'c-remote', provider: 'hetzner', metricsTokenHash: hash },
] as ClusterMetadata[];

const relayWith = (status = 204) => {
  const write = vi.fn(async (_body: Buffer) => ({ status, text: status < 300 ? '' : 'out of bounds' }));
  return { write, relay: new MachineMetricsRelay({ clusters: async () => clusters, write }) };
};

describe('the relay a machine sends its metrics through', () => {
  it('passes a batch on under the cluster whose token sent it', async () => {
    const { write, relay } = relayWith();
    const body = Buffer.from(compress(series(label('__name__', 'up'))));
    expect(await relay.write(token, body)).toEqual({ status: 204 });
    expect(Buffer.from(uncompress(write.mock.calls[0]![0])).includes(Buffer.from('machine-desk'))).toBe(true);
  });

  it('refuses no token, a token no machine cluster holds, and a body that is not snappy, passing nothing on', async () => {
    const { write, relay } = relayWith();
    expect(await relay.write(undefined, Buffer.alloc(0))).toMatchObject({ status: 401 });
    expect(await relay.write('guess', Buffer.alloc(0))).toMatchObject({ status: 401 });
    expect(await relay.write(token, Buffer.from('nope'))).toMatchObject({ status: 400 });
    expect(write).not.toHaveBeenCalled();
  });

  it('says what Prometheus refused', async () => {
    const { relay } = relayWith(400);
    expect(await relay.write(token, Buffer.from(compress(series(label('__name__', 'up')))))).toEqual({ status: 400, text: 'out of bounds' });
  });
});
