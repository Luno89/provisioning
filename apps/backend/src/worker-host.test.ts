import { describe, expect, it } from 'vitest';
import { HOST_ACTIVITIES } from './platform/index.js';
import { HOST_WORKER_ACTIVITIES, hostActivitiesFor } from './worker-host.js';

describe('what the host worker serves in each role', () => {
  it('has every one of its activities in exactly one role\'s list, and no listed activity it lacks', () => {
    const listed = [...HOST_ACTIVITIES.root, ...HOST_ACTIVITIES.instance];
    expect(listed.filter((name, index) => listed.indexOf(name) !== index)).toEqual([]);
    expect([...listed].sort()).toEqual(Object.keys(HOST_WORKER_ACTIVITIES).sort());
  });

  it('serves root its own work and an instance its own', () => {
    expect(Object.keys(hostActivitiesFor('root')).sort()).toEqual([...HOST_ACTIVITIES.root].sort());
    expect(Object.keys(hostActivitiesFor('instance')).sort()).toEqual([...HOST_ACTIVITIES.instance].sort());
  });
});
