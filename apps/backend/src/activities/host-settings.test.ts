import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ClusterAccess } from '../infrastructure/index.js';
import type { DependencyReporter, HostWorkerSettings } from '../platform/index.js';
import { giveHostActivities, hostAccess, hostDependencies, hostSettings } from './host-settings.js';

describe('what the host worker gives its activities', () => {
  it('is refused, saying where it comes from, to an activity that runs before the worker gave it', () => {
    const said = 'the host worker\'s activities were not given its settings: worker-host.ts gives them before it takes work';
    expect(() => hostSettings()).toThrow(said);
    expect(() => hostAccess()).toThrow(said);
    expect(() => hostDependencies()).toThrow(said);
  });

  it('is the settings, the cluster access and the dependency states the worker gave, the same for every activity', () => {
    const settings = { dataDir: '/data' } as unknown as HostWorkerSettings;
    const access = mock<ClusterAccess>();
    const dependencies = mock<DependencyReporter>();
    giveHostActivities(settings, access, dependencies);
    expect(hostSettings()).toBe(settings);
    expect(hostAccess()).toBe(access);
    hostDependencies().answered('mongo');
    expect(dependencies.answered).toHaveBeenCalledWith('mongo');
  });
});
