import { describe, expect, it } from 'vitest';
import { INFISICAL_NAME_LIMIT, readerNameFor, readerPrefixFor, workspaceNameFor } from './infisical-names.js';

const planProject = 'project-plan-a0e49fdc-b1a5-4f7f-b1c7-d2e8bdb435e6-tree';
const now = Date.UTC(2026, 9, 25);

describe('names Infisical takes for a project', () => {
  it('keeps the name a short project id always had', () => {
    expect(workspaceNameFor('e0443297-d585-481b-a7b4-fe616d9b34b1')).toBe('provisioning-e0443297-d585-481b-a7b4-fe616d9b34b1');
    expect(readerPrefixFor('p1')).toBe('reader-p1-');
  });

  it('fits a plan-made project within the limit, the same way every time', () => {
    const name = workspaceNameFor(planProject);
    expect(name.length).toBeLessThanOrEqual(INFISICAL_NAME_LIMIT);
    expect(name.startsWith('provisioning-project-plan-a0e49fdc')).toBe(true);
    expect(workspaceNameFor(planProject)).toBe(name);
    expect(readerNameFor(planProject, now).length).toBeLessThanOrEqual(INFISICAL_NAME_LIMIT);
    expect(readerNameFor(planProject, now).startsWith(readerPrefixFor(planProject))).toBe(true);
  });

  it('never gives two projects that share a long start the same name', () => {
    const other = planProject.replace(/-tree$/, '-tree2');
    expect(workspaceNameFor(other)).not.toBe(workspaceNameFor(planProject));
    expect(readerPrefixFor(other)).not.toBe(readerPrefixFor(planProject));
  });

  it('never lets one project\'s reader prefix take in another project\'s readers', () => {
    expect(readerNameFor('p10', now).startsWith(readerPrefixFor('p1'))).toBe(false);
  });
});
