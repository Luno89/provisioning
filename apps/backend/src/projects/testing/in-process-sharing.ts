import type { Database } from '../../platform/index.js';
import type { HubService } from '../../hub/index.js';
import type { HubSharing, ProjectGroups } from '../services/ProjectSharingService.js';

export function localHubSharing(hub: { share: HubService['share']; unshare: HubService['unshare'] }, instanceId: string): HubSharing {
  return {
    reachable: async () => true,
    async share(owner, project) {
      const outcome = await hub.share({ kind: 'instance', personId: owner.id, instanceId, email: owner.email }, { name: project.name, projectId: project.id, group: project.group });
      if (!outcome.ok) throw new Error(outcome.why);
      return { hubProjectId: outcome.value.view.project.id, ...(outcome.value.repo ? { repo: outcome.value.repo } : {}) };
    },
    async unshare(ownerId, hubProjectId) {
      const outcome = await hub.unshare({ kind: 'instance', personId: ownerId, instanceId }, hubProjectId);
      if (!outcome.ok && outcome.status !== 404) throw new Error(outcome.why);
    },
  };
}

export function localProjectGroups(store: Pick<Database, 'hub'>): ProjectGroups {
  const holder = async (name: string) => (await store.hub.getHubLinks()).find((entry) => entry.group === name);
  return {
    check: async (name) => ((await holder(name)) ? `"${name}" is taken` : null),
    async claim(projectId, name) {
      const held = await holder(name);
      if (held && held.projectId !== projectId) throw new Error(`"${name}" is taken`);
    },
    release: async () => {},
  };
}
