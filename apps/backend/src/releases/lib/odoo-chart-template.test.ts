import { describe, it, expect } from 'vitest';
import { ODOO_CHART_FILES } from './odoo-chart-template.js';

describe('the Odoo chart', () => {
  it('has Odoo listen beyond its own pod, which Odoo 20 no longer does unless told, so the probe and the service reach it', () => {
    const deployment = ODOO_CHART_FILES.map((file) => file.content).find((content) => content.includes('--db-filter=^odoo_'));
    expect(deployment).toContain('- --http-interface=0.0.0.0');
    expect(deployment).toContain('httpGet: { path: /web/health, port: 8069 }');
  });
});
