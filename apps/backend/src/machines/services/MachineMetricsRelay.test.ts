import { uncompress, compress } from 'snappyjs';
import { describe, expect, it, vi } from 'vitest';
import type { LocalAgentDeviceMetadata } from '../../platform/lib/types.js';
import type { MachineAdmission } from '../wiring/machine-admission.js';
import { MachineMetricsRelay } from './MachineMetricsRelay.js';

const label = (name: string, value: string) => {
  const field = (number: number, text: string) => Buffer.concat([Buffer.from([number * 8 + 2, text.length]), Buffer.from(text)]);
  const body = Buffer.concat([field(1, name), field(2, value)]);
  return Buffer.concat([Buffer.from([10, body.length]), body]);
};
const series = (...labels: Buffer[]) => { const body = Buffer.concat(labels); return Buffer.concat([Buffer.from([10, body.length]), body]); };

const DESK = { id: 'desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', createdAt: 'then' } as LocalAgentDeviceMetadata;

const relayWith = (status = 204) => {
  const write = vi.fn(async (_body: Buffer) => ({ status, text: status < 300 ? '' : 'out of bounds' }));
  const admit = vi.fn(async (token: string): Promise<MachineAdmission | string> => (token === 'from-root' ? { device: DESK, until: Date.now() + 300_000 } : 'Unauthorized: the metrics token could not be checked: signature verification failed'));
  return { write, admit, relay: new MachineMetricsRelay({ admit, write }) };
};

describe('the relay a machine sends its metrics through', () => {
  it('passes a batch on under the cluster of the machine root\'s token names', async () => {
    const { write, admit, relay } = relayWith();
    const body = Buffer.from(compress(series(label('__name__', 'up'))));
    expect(await relay.write('from-root', body)).toEqual({ status: 204 });
    expect(admit).toHaveBeenCalledWith('from-root');
    expect(Buffer.from(uncompress(write.mock.calls[0]![0])).includes(Buffer.from('machine-desk'))).toBe(true);
  });

  it('refuses no token and one admission refuses, saying why, and a body that is not snappy, passing nothing on', async () => {
    const { write, relay } = relayWith();
    expect(await relay.write(undefined, Buffer.alloc(0))).toMatchObject({ status: 401 });
    expect(await relay.write('guess', Buffer.alloc(0))).toEqual({ status: 401, text: 'Unauthorized: the metrics token could not be checked: signature verification failed' });
    expect(await relay.write('from-root', Buffer.from('nope'))).toMatchObject({ status: 400 });
    expect(write).not.toHaveBeenCalled();
  });

  it('says what Prometheus refused', async () => {
    const { relay } = relayWith(400);
    expect(await relay.write('from-root', Buffer.from(compress(series(label('__name__', 'up')))))).toEqual({ status: 400, text: 'out of bounds' });
  });
});
