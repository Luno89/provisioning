import { codeTimeout, declaredSockets, valueImplementation, type NodeImplementation } from '@koala/agent-engine/procedure';
import { handleFor, ticketFor, type HostNodeServices } from './services.js';
import type { RunEnvironment } from '../temporal/contracts.js';

export function createCodeNodes(services: Pick<HostNodeServices, 'code'>): NodeImplementation[] {
  return [
    valueImplementation('code', async ({ node, inputs, run }) => {
      if (!services.code) throw new Error('nothing here can run a code node');

      const given = Object.fromEntries(
        declaredSockets(node.settings, 'inputs').map((socket) => [socket.name, inputs[socket.name]]),
      );

      const environment = handleFor(inputs.environment as RunEnvironment | undefined);

      const outcome = await services.code.run({
        ticket: ticketFor(run),
        ...(environment ? { environment } : {}),
        nodeId: node.id,
        body: String(node.settings.body ?? ''),
        inputs: given,
        timeoutMs: codeTimeout(node.settings),
      });

      if (!outcome.ok) throw new Error(outcome.error);

      return {
        outputs: Object.fromEntries(
          declaredSockets(node.settings, 'outputs').map((socket) => [socket.name, outcome.outputs[socket.name]]),
        ),
      };
    }),
  ];
}
