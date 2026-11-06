import { describe, expect, it } from 'vitest';
import { parser } from '@prometheus-io/lezer-promql';
import { ROOT_ALERTS, ROOT_PROCESSES, ROOT_RULE_IDS, ROOT_SERVICES, rootAlertsManifest } from './root-alerts.js';
import { RULE_LABEL } from './monitoring-alerts.js';

const parses = (query: string): boolean => {
  let broken = false;
  parser.parse(query).iterate({ enter: (node) => { if (node.type.isError) broken = true; } });
  return !broken;
};

describe('the alerts root sets on its own cluster', () => {
  it('watches each of root\'s Koala processes, each service beside them, the disk, memory, failing work and the last backup', () => {
    const ids = ROOT_ALERTS.map((alert) => alert.id);
    for (const process of ROOT_PROCESSES) expect(ids).toContain(`root-${process.service}-down`);
    for (const service of ROOT_SERVICES) expect(ids).toContain(`root-${service}-down`);
    expect(ids).toEqual(expect.arrayContaining(['root-disk', 'root-memory', 'root-workflow-failures', 'root-backup-stale']));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ROOT_RULE_IDS.size).toBe(ids.length);
  });

  it('asks only of root\'s own processes, by their role, so nothing else on the cluster counts as root', () => {
    for (const alert of ROOT_ALERTS.filter((entry) => entry.expr.includes('koala_'))) {
      if (alert.id === 'root-backup-stale') continue;
      expect(alert.expr).toContain('koala_role="root"');
    }
  });

  it('writes every expression as PromQL Prometheus parses', () => {
    for (const alert of ROOT_ALERTS) expect(parses(alert.expr), alert.expr).toBe(true);
  });

  it('puts them in one PrometheusRule in monitoring, each labelled with its id, which the operator stack picks up', () => {
    const manifest = rootAlertsManifest() as { kind: string; metadata: { namespace: string; labels: Record<string, string> }; spec: { groups: Array<{ rules: Array<{ alert: string; expr: string; labels: Record<string, string>; annotations: { summary: string } }> }> } };
    expect(manifest.kind).toBe('PrometheusRule');
    expect(manifest.metadata.namespace).toBe('monitoring');
    expect(manifest.metadata.labels.release).toBe('kube-prometheus-stack');
    const rules = manifest.spec.groups[0]!.rules;
    expect(rules.map((rule) => rule.labels[RULE_LABEL])).toEqual(ROOT_ALERTS.map((alert) => alert.id));
    expect(rules.every((rule) => rule.annotations.summary.length > 0)).toBe(true);
  });
});
