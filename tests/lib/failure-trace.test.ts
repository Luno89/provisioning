import { describe, expect, it } from 'vitest';
import { callerLines, failuresUnder, flowsThrough, spansOf, whereLines } from './failure-trace.js';

const b64 = (hex: string): string => Buffer.from(hex, 'hex').toString('base64');
const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
const int = (key: string, value: number) => ({ key, value: { intValue: String(value) } });

const tempo = {
  batches: [
    {
      resource: { attributes: [str('service.name', 'koala-worker-engine')] },
      scopeSpans: [{ spans: [
        { spanId: b64('00000000000000a1'), parentSpanId: b64('0000000000000001'), name: 'activity CheckRunScenarioActivity', attributes: [], status: {} },
        { spanId: b64('00000000000000b1'), parentSpanId: b64('0000000000000001'), name: 'activity CheckRunScenarioActivity', attributes: [], status: {} },
      ] }],
    },
    {
      resource: { attributes: [str('service.name', 'koala-backend')] },
      scopeSpans: [{ spans: [
        { spanId: b64('00000000000000a2'), parentSpanId: b64('00000000000000a1'), name: 'POST /api/deployments', status: {}, attributes: [str('http.route', '/api/deployments'), int('http.response.status_code', 404)],
          events: [{ name: 'koala.refused', attributes: [str('koala.action', 'deploy-to'), str('koala.resource', 'cluster'), str('koala.claims', 'person'), int('koala.status', 404), str('code.function', 'ClusterService.getById'), str('code.filepath', 'apps/backend/src/infrastructure/services/ClusterService.ts'), int('code.lineno', 86)] }] },
        { spanId: b64('00000000000000a3'), parentSpanId: b64('00000000000000a1'), name: 'GET /api/clusters', status: {}, attributes: [int('http.response.status_code', 200)],
          events: [{ name: 'koala.refused', attributes: [str('koala.action', 'see'), str('koala.resource', 'cluster')] }] },
        { spanId: b64('00000000000000b2'), parentSpanId: b64('00000000000000b1'), name: 'POST /api/chat', status: { code: 'STATUS_CODE_ERROR' }, attributes: [int('http.response.status_code', 500), str('error.type', 'TypeError'), str('code.filepath', 'apps/backend/src/engine/routes/chat.ts'), int('code.lineno', 12)] },
      ] }],
    },
  ],
};

describe('where a check failed, read from its trace', () => {
  it('reads Tempo\'s spans with their ids as hex, whatever encoding Tempo used', () => {
    const spans = spansOf(tempo);
    expect(spans.map((span) => span.spanId)).toContain('00000000000000a2');
    expect(spans.find((span) => span.spanId === '00000000000000a2')).toMatchObject({ service: 'koala-backend', parentSpanId: '00000000000000a1', attributes: { 'http.response.status_code': 404 } });
  });

  it('finds what failed under the check\'s own span only, with the path down to it, its throw site and what was refused there', () => {
    const failures = failuresUnder(spansOf(tempo), '00000000000000a1');
    expect(failures).toHaveLength(1);
    expect(whereLines(failures)).toEqual([
      'koala-worker-engine: activity CheckRunScenarioActivity',
      '  └ koala-backend: POST /api/deployments answered 404',
      '      refused deploy-to on a cluster (claims: person) at ClusterService.getById (apps/backend/src/infrastructure/services/ClusterService.ts:86)',
    ]);
  });

  it('names the throw site of a span that threw, and leaves out answers that succeeded however much they refused', () => {
    const failures = failuresUnder(spansOf(tempo), '00000000000000b1');
    expect(whereLines(failures)).toEqual([
      'koala-worker-engine: activity CheckRunScenarioActivity',
      '  └ koala-backend: POST /api/chat answered 500, threw TypeError at apps/backend/src/engine/routes/chat.ts:12',
    ]);
    expect(failures[0]!.sites).toEqual([{ filepath: 'apps/backend/src/engine/routes/chat.ts', function: undefined, lineno: 12 }]);
  });
});

describe('the developer tools on a throw site', () => {
  it('names the flows a file is on', () => {
    const snapshot = { flows: { 'deploy-app': { files: { files: [{ file: 'a.ts' }, { file: 'b.ts' }] } }, chat: { files: { files: [{ file: 'c.ts' }] } } } };
    expect(flowsThrough(snapshot, 'b.ts')).toEqual(['deploy-app']);
    expect(flowsThrough(snapshot, 'x.ts')).toEqual([]);
  });

  it('keeps the callers refs finds in the product, leaving out tests and declarations', () => {
    const out = [
      'apps/backend/src/infrastructure/routes/deployments.ts:58:49  read         const targetCluster = await clusterService.getById(',
      'apps/backend/src/infrastructure/services/ClusterService.ts:84:9  declaration  async getById(',
      'apps/backend/src/projects/routes/projects.test.ts:35:12  read         clusters.getById.mockImplementation(',
      'apps/backend/src/models/testing/model-service-behaviour.ts:250:16  read         clusters.getById.mockResolvedValue(cluster);',
      '26 references to ClusterService.getById in 13.1 s',
    ].join('\n');
    expect(callerLines(out)).toEqual(['apps/backend/src/infrastructure/routes/deployments.ts:58:49  const targetCluster = await clusterService.getById(']);
  });
});

describe('several failures under one check', () => {
  it('prints the path they share once', () => {
    const both = [...failuresUnder(spansOf(tempo), '00000000000000a1'), ...failuresUnder(spansOf(tempo), '00000000000000a1')];
    const root = both[0]!.path[0]!;
    const second = { path: [root, { ...both[0]!.path[1]!, name: 'GET /api/other' }], sites: [] };
    expect(whereLines([both[0]!, second])).toEqual([
      'koala-worker-engine: activity CheckRunScenarioActivity',
      '  └ koala-backend: POST /api/deployments answered 404',
      '      refused deploy-to on a cluster (claims: person) at ClusterService.getById (apps/backend/src/infrastructure/services/ClusterService.ts:86)',
      '  └ koala-backend: GET /api/other answered 404',
      '      refused deploy-to on a cluster (claims: person) at ClusterService.getById (apps/backend/src/infrastructure/services/ClusterService.ts:86)',
    ]);
  });
});
