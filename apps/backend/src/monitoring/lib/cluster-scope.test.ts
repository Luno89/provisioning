import { describe, expect, it } from 'vitest';
import { inCluster, OWN_SERIES } from './cluster-scope.js';
import { APP_QUESTIONS, appQuery, CLUSTER_QUESTIONS, clusterQuery, KOALA_QUESTIONS, koalaQuery, USAGES, usageQuery, WINDOW_QUESTIONS, appWindowQuery } from './monitoring-questions.js';

const selectors = (query: string) => query.match(/[a-z_:]+\{[^}]*\}/g) ?? [];

describe('a question asked of one cluster in a Prometheus several send to', () => {
  it('puts the cluster on every selector, with or without matchers of its own, and on none of the functions, durations or strings', () => {
    expect(inCluster('sum(rate(foo{a="b"}[5m])) / count(bar)', 'machine-desk'))
      .toBe('sum(rate(foo{koala_cluster="machine-desk",a="b"}[5m])) / count(bar{koala_cluster="machine-desk"})');
    expect(inCluster('max by (namespace) (up{}) or vector(0)', 'machine-desk')).toBe('max by (namespace) (up{koala_cluster="machine-desk"}) or vector(0)');
    expect(inCluster('label_replace(x, "namespace", "$1", "pod", "(.+)")', 'm')).toBe('label_replace(x{koala_cluster="m"}, "namespace", "$1", "pod", "(.+)")');
    expect(inCluster('{__name__="up"}', 'm')).toBe('{koala_cluster="m",__name__="up"}');
  });

  it('keeps a cluster\'s own questions to the series no machine sent', () => {
    expect(inCluster('count(kube_node_info)', OWN_SERIES)).toBe('count(kube_node_info{koala_cluster=""})');
  });

  it('cannot be escaped by a matcher the question already has', () => {
    expect(inCluster('up{koala_cluster="machine-other"}', 'machine-desk')).toBe('up{koala_cluster="machine-desk",koala_cluster="machine-other"}');
  });

  it('refuses what does not parse rather than asking it unscoped', () => {
    expect(() => inCluster('sum(foo{a="b"', 'm')).toThrow(/not a query Koala asks/);
  });

  it('scopes every question Koala asks, each selector in it', () => {
    const app = { namespace: 'books-abc123', services: ['books'] };
    const asked = [
      ...APP_QUESTIONS.map((question) => appQuery(question, app)),
      ...WINDOW_QUESTIONS.map((question) => appWindowQuery(question, app, 3600)),
      ...CLUSTER_QUESTIONS.map((question) => clusterQuery(question)),
      ...USAGES.map((usage) => usageQuery(usage)),
      ...KOALA_QUESTIONS.map((question) => koalaQuery(question)),
    ].filter((query): query is string => query !== undefined);
    for (const query of asked) {
      const scoped = inCluster(query, 'machine-desk');
      for (const selector of selectors(scoped)) expect(selector, query).toContain('koala_cluster="machine-desk"');
      expect(selectors(scoped).length, query).toBeGreaterThan(0);
    }
  });
});
