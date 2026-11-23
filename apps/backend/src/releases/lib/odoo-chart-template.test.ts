import { describe, it, expect } from 'vitest';
import { ODOO_CHART_FILES } from './odoo-chart-template.js';

describe('the Odoo chart', () => {
  it('has Odoo listen beyond its own pod, which Odoo 20 no longer does unless told, so the probe and the service reach it', () => {
    const deployment = ODOO_CHART_FILES.map((file) => file.content).find((content) => content.includes('--db-filter=^odoo_'));
    expect(deployment).toContain('- --http-interface=0.0.0.0');
    expect(deployment).toContain('httpGet: { path: /web/health, port: 8069 }');
  });

  it('runs Odoo and its Postgres as nothing of Koala\'s: no service account, no token, nothing privileged, no host folder', () => {
    const workloads = ODOO_CHART_FILES.flatMap((file) => file.content.split('\n---\n')).filter((text) => /^kind: (Deployment|StatefulSet|Job|Pod)$/m.test(text));
    expect(workloads.map((text) => /^kind: (\w+)$/m.exec(text)?.[1])).toEqual(['StatefulSet', 'Deployment']);
    for (const text of workloads) {
      expect(text).toMatch(/\n  template:\n(?: {4}.*\n)*? {4}spec:\n {6}automountServiceAccountToken: false\n/);
      expect(text).not.toMatch(/serviceAccount|privileged|hostPath/);
    }
  });
});
