import { describe, it, expect } from 'vitest';
import { clusterHost, clusterAuthority, clusterUrl } from './cluster-dns.js';
import { mcpUrlFor } from './mcp-registry.js';
import { inClusterBaseUrl, LLM_APPS } from './llm-apps.js';

describe('the DNS name Kubernetes gives a Service', () => {
  it('is service, then namespace, then the cluster domain', () => {
    expect(clusterHost('mongo', 'spec-mongo')).toBe('mongo.spec-mongo.svc.cluster.local');
  });

  it('is fully qualified, not the short form', () => {
    expect(clusterHost('mongo', 'spec-mongo')).toContain('.svc.cluster.local');
  });

  it('joins host and port for a client that wants no scheme', () => {
    expect(clusterAuthority({ service: 'mongo', namespace: 'spec-mongo', port: 27017 }))
      .toBe('mongo.spec-mongo.svc.cluster.local:27017');
  });
});

describe('building a URL', () => {
  it('defaults to http, because this is pod-to-pod inside one cluster', () => {
    expect(clusterUrl({ service: 'minio', namespace: 'minio', port: 9000 }))
      .toBe('http://minio.minio.svc.cluster.local:9000');
  });

  it('appends a path exactly as given, and guesses at none', () => {
    expect(clusterUrl({ service: 'gitapp', namespace: 'x', port: 8080 }, { path: '/mcp' }))
      .toBe('http://gitapp.x.svc.cluster.local:8080/mcp');
    expect(clusterUrl({ service: 'gitapp', namespace: 'x', port: 8080 })).toMatch(/:8080$/);
  });

  it('takes a scheme when a caller has one', () => {
    expect(clusterUrl({ service: 's', namespace: 'n', port: 1 }, { scheme: 'https' }))
      .toMatch(/^https:\/\//);
  });
});

describe('the three callers still produce what they produced before', () => {
  it('minio, for quickwit\'s S3 endpoint', () => {
    expect(clusterUrl({ service: 'minio', namespace: 'koala-store', port: 9000 }))
      .toBe('http://minio.koala-store.svc.cluster.local:9000');
  });

  it('an MCP server, which a sandbox calls', () => {
    expect(mcpUrlFor({ name: 'github-mcp' }, 'koala-request-30b2d228', 8080))
      .toBe('http://gitapp.koala-request-30b2d228.svc.cluster.local:8080/mcp');
  });

  it('an LLM endpoint, whose Service is named differently', () => {
    const spec = LLM_APPS.find((a) => a.serviceSuffix)!;
    const url = inClusterBaseUrl(spec, 'my-llm');
    expect(url).toBe(`http://my-llm-${spec.serviceSuffix}.my-llm.svc.cluster.local:${spec.port}${spec.apiPath}`);
    expect(url.startsWith('http://my-llm-')).toBe(true);
  });
});
