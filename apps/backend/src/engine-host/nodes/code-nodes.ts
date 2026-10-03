import {
  CODE_KIND,
  RUN_CODE_KIND,
  codeTimeout,
  declaredSockets,
  stepImplementation,
  valueImplementation,
  type NodeImplementation,
  type NodeRequest,
} from '@koala/agent-engine/procedure';
import { handleFor, ticketFor, type HostNodeServices } from './services.js';
import type { RunEnvironment } from '../temporal/contracts.js';

type Ran = { ok: true; outputs: Record<string, unknown> } | { ok: false; error: string };

export function createCodeNodes(services: Pick<HostNodeServices, 'code'>): NodeImplementation[] {
  const run = async ({ node, inputs, run: identity }: NodeRequest): Promise<Ran> => {
    if (!services.code) throw new Error('nothing here can run a code node');

    const given = Object.fromEntries(
      declaredSockets(node.settings, 'inputs').map((socket) => [socket.name, inputs[socket.name]]),
    );
    const environment = handleFor(inputs.environment as RunEnvironment | undefined);

    const outcome = await services.code.run({
      ticket: ticketFor(identity),
      ...(environment ? { environment } : {}),
      nodeId: node.id,
      body: String(node.settings.body ?? ''),
      inputs: given,
      timeoutMs: codeTimeout(node.settings),
    });
    if (!outcome.ok) return { ok: false, error: outcome.error };

    return {
      ok: true,
      outputs: Object.fromEntries(
        declaredSockets(node.settings, 'outputs').map((socket) => [socket.name, outcome.outputs[socket.name]]),
      ),
    };
  };

  return [
    valueImplementation(CODE_KIND, async (request) => {
      const ran = await run(request);
      if (!ran.ok) throw new Error(ran.error);
      return { outputs: ran.outputs };
    }),
    stepImplementation(RUN_CODE_KIND, async (request) => {
      const ran = await run(request);
      return ran.ok ? { exit: 'ok', outputs: ran.outputs } : { exit: 'failed', outputs: { error: ran.error } };
    }),
  ];
}
