import { describe, it, expect } from 'vitest';
import { deliveryFor, RELEASE_STATES } from './delivery.js';
import { TREE_TYPE_SEEDS } from './tree-type-seeds.js';

const seed = (id: string) => TREE_TYPE_SEEDS.find((type) => type.id === id)!;

describe('what happens to work that lands, by tree type', () => {
  it('releases a type whose starter carries the A/B chart, describing every state a release can be in', () => {
    const odoo = deliveryFor(seed('odoo-addons'));
    expect(odoo.path).toBe('chart-release');
    for (const [state, says] of Object.entries(RELEASE_STATES)) expect(odoo.says).toContain(`${state}: ${says}.`);
    expect(odoo.owns).toEqual(expect.arrayContaining(['deploying or releasing', 'creating, copying or upgrading databases']));
  });

  it('builds and deploys a service whose starter has a Dockerfile', () => {
    for (const id of ['api-service', 'mcp-server', 'ui-app']) expect(deliveryFor(seed(id)).path, id).toBe('image-deploy');
  });

  it('builds nothing for a service with no Dockerfile until the work adds one', () => {
    for (const id of ['docs-site', 'freeform']) expect(deliveryFor(seed(id)).path, id).toBe('waits-for-dockerfile');
  });

  it('delivers nothing for a type that produces an answer', () => {
    for (const type of TREE_TYPE_SEEDS.filter((entry) => entry.produces === 'artefact')) expect(deliveryFor(type).path, type.id).toBe('none');
  });
});
