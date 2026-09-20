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
      const ours = environment?.kind === 'sandbox' && environment.handedOver !== true;
      if (ours) await services.environments.release(run.identity.runId);
      return { exit: 'done' };
    }),
  ];
}
