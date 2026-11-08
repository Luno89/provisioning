import type { HubService } from '../services/HubService.js';
import type { HubSyncTransport } from '../services/HubSyncService.js';
import type { InstanceCall } from '../services/HubInstanceWork.js';
import type { RelayAnswer, RelayCall } from '../services/HubRelay.js';
import type { HubPeople } from '../services/HubPeople.js';
import type { HubLink } from '../lib/hub-sync.js';

type LocalHub = Pick<HubService, 'receive' | 'changesSince' | 'waitingRequests' | 'settleRequest' | 'putStatus' | 'connectInstance' | 'answerRelay'>;

const fromRelay = (call: RelayCall): InstanceCall => ({
  id: call.id,
  projectId: call.projectId,
  op: call.op,
  args: call.args,
  as: call.as,
  ...(call.upload ? { upload: { type: call.upload.type, ...(call.upload.size !== undefined ? { size: call.upload.size } : {}), open: async () => call.upload!.stream } } : {}),
});

export function localHubSync(hub: LocalHub, instanceId: string): HubSyncTransport {
  const origin = (link: HubLink) => ({ kind: 'instance' as const, personId: link.ownerId, instanceId });
  const failed = (outcome: { ok: false; status: number; why: string }) => Object.assign(new Error(outcome.why), { status: outcome.status });
  return {
    async requests(link) {
      const outcome = await hub.waitingRequests(origin(link), link.hubProjectId);
      if (!outcome.ok) throw failed(outcome);
      return outcome.value;
    },
    async settle(link, requestId, settled) {
      const outcome = await hub.settleRequest(origin(link), link.hubProjectId, requestId, settled);
      if (!outcome.ok) throw failed(outcome);
    },
    async status(link, status) {
      const outcome = await hub.putStatus(origin(link), link.hubProjectId, status);
      if (!outcome.ok) throw failed(outcome);
    },
    connect(line) {
      const connected = hub.connectInstance({ kind: 'instance', personId: '', instanceId }, {
        call: (call) => line.call(fromRelay(call)),
        changed: (projectId) => line.changed(projectId),
      });
      if (!connected.ok) throw failed(connected);
      queueMicrotask(() => line.connected());
      return connected.value;
    },
    async answer(link, callId, answer) {
      const outcome = await hub.answerRelay(origin(link), callId, answer as RelayAnswer);
      if (!outcome.ok) throw failed(outcome);
    },
    async push(link, changes) {
      const outcome = await hub.receive(origin(link), link.hubProjectId, changes);
      if (!outcome.ok) throw Object.assign(new Error(outcome.why), { status: outcome.status });
      return outcome.value;
    },
    async pull(link, after) {
      const outcome = await hub.changesSince(origin(link), link.hubProjectId, after);
      if (!outcome.ok) throw Object.assign(new Error(outcome.why), { status: outcome.status });
      return outcome.value;
    },
  };
}

export function localHubPeople(hub: HubService): HubPeople {
  return {
    blockers: async (personId) => (await hub.leaving(personId)).blockers,
    letGo: async (personId) => { await hub.letGo(personId); },
  };
}
