import protobuf from 'protobufjs';
import { compress, uncompress } from 'snappyjs';
import { describe, expect, it } from 'vitest';
import { METRICS_MAX_BYTES, stampedBody, stampedWrite } from './machine-metrics.js';

const prompb = protobuf.parse(`
syntax = "proto3";
message WriteRequest { repeated TimeSeries timeseries = 1; repeated MetricMetadata metadata = 3; }
message MetricMetadata { int32 type = 1; string metric_family_name = 2; string help = 4; string unit = 5; }
message TimeSeries { repeated Label labels = 1; repeated Sample samples = 2; }
message Label { string name = 1; string value = 2; }
message Sample { double value = 1; int64 timestamp = 2; }
`).root;
const WriteRequest = prompb.lookupType('WriteRequest');

interface Written { timeseries: Array<{ labels: Array<{ name: string; value: string }>; samples: Array<{ value: number; timestamp: number }> }>; metadata?: Array<{ metricFamilyName: string }> }

const encode = (request: Written) => Buffer.from(WriteRequest.encode(WriteRequest.fromObject(request)).finish());
const decode = (bytes: Buffer) => WriteRequest.toObject(WriteRequest.decode(bytes), { longs: Number, defaults: true }) as Written;

const sent: Written = {
  timeseries: [
    { labels: [{ name: '__name__', value: 'probe_success' }, { name: 'koala_cluster', value: 'machine-someone-else' }, { name: 'namespace', value: 'books' }], samples: [{ value: 1, timestamp: 1_793_000_000_000 }] },
    { labels: [{ name: '__name__', value: 'up' }, { name: 'zone', value: 'a' }], samples: [{ value: 0, timestamp: 1_793_000_000_001 }, { value: 1, timestamp: 1_793_000_015_001 }] },
  ],
  metadata: [{ metricFamilyName: 'up' }],
};

describe('what a machine sends to the instance\'s Prometheus', () => {
  it('is stored under its own cluster, whatever it claimed, the labels kept in order and every sample and the metadata as sent', () => {
    const stamped = decode(stampedWrite(encode(sent), 'machine-desk'));
    expect(stamped.timeseries.map((series) => series.labels)).toEqual([
      [{ name: '__name__', value: 'probe_success' }, { name: 'koala_cluster', value: 'machine-desk' }, { name: 'namespace', value: 'books' }],
      [{ name: '__name__', value: 'up' }, { name: 'koala_cluster', value: 'machine-desk' }, { name: 'zone', value: 'a' }],
    ]);
    expect(stamped.timeseries.map((series) => series.samples)).toEqual(sent.timeseries.map((series) => series.samples));
    expect(stamped.metadata?.map((entry) => entry.metricFamilyName)).toEqual(['up']);
  });

  it('comes and goes snappy-compressed, as remote write sends it', () => {
    const body = Buffer.from(compress(encode(sent)));
    const stamped = decode(Buffer.from(uncompress(stampedBody(body, 'machine-desk'))));
    expect(stamped.timeseries).toHaveLength(2);
  });

  it('refuses a body that is not snappy or would unpack past the limit', () => {
    expect(() => stampedBody(Buffer.from('not snappy at all'), 'machine-desk')).toThrow();
    const huge = Buffer.from(compress(Buffer.alloc(METRICS_MAX_BYTES + 1)));
    expect(() => stampedBody(huge, 'machine-desk')).toThrow();
  });
});
