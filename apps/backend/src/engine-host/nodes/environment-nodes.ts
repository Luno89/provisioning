import {
  stepImplementation,
  type EnvironmentValue,
  type NodeImplementation,
} from '@koala/agent-engine/procedure';
import { ticketFor, type HostNodeServices } from './services.js';

export function createEnvironmentNodes(services: HostNodeServices): NodeImplementation[] {
  return [
    stepImplementation('provision-sandbox', async ({ run }) => {
      const handed = run.launch.environment as EnvironmentValue | undefined;
      if (handed) return { exit: 'ready', outputs: { environment: { ...handed, handedOver: true } } };

      const conversationId = run.identity.depth === 0 ? run.launch.conversationId : undefined;
      if (conversationId && services.conversationWorkspaces) {
        try {
          const shared = await services.conversationWorkspaces.describe({ conversationId, ownerId: run.launch.ownerId, agentSlug: run.identity.agentId });
          if (shared) return { exit: 'ready', outputs: { environment: shared } };
        } catch (err) {
          return { exit: 'unavailable', outputs: { reason: `the conversation's workspace could not be provided: ${(err as Error).message}` } };
        }
      }

      const waiting = await services.images?.waiting(run.launch.ownerId, run.identity.agentId).catch(() => undefined);
      if (waiting) run.emit({ type: 'notice', level: 'info', message: waiting } as never);

      try {
        const environment = await services.environments.describe(ticketFor(run), run.budget.maxWallClockMs);
        return { exit: 'ready', outputs: { environment } };
      } catch (err) {
        return { exit: 'unavailable', outputs: { reason: `no environment could be provided: ${(err as Error).message}` } };
      }
    }),

    stepImplementation('release-sandbox', async ({ inputs, run }) => {
      const environment = inputs.environment as (EnvironmentValue & { handedOver?: boolean }) | undefined;
      const conversationId = run.launch.conversationId;
      const conversations = environment?.kind === 'sandbox' && environment.handedOver !== true
        && environment.workspace?.sharedBy === 'conversation' && conversationId
        ? services.conversationWorkspaces
        : undefined;
      if (conversations && conversationId) {
        const saved = await conversations.save({ conversationId, ownerId: run.launch.ownerId })
          .catch((err: Error) => ({ saved: false as const, why: err.message, failed: true as const }));
        if (!saved.saved && 'failed' in saved && saved.failed) {
          run.emit({ type: 'notice', level: 'info', message: `this conversation's documents were not saved yet: ${saved.why}` } as never);
        }
        return { exit: 'done' };
      }
      const ours = environment?.kind === 'sandbox' && environment.handedOver !== true;
      if (ours) await services.environments.release(run.identity.runId);
      return { exit: 'done' };
    }),
  ];
}
