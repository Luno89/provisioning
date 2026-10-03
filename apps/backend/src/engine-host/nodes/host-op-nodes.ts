import { HOST_OP_KIND, stepImplementation, type NodeImplementation } from '@koala/agent-engine/procedure';
import type { HostNodeServices } from './services.js';

export function createHostOpNodes(services: HostNodeServices): NodeImplementation[] {
  return [
    stepImplementation(HOST_OP_KIND, async (request) => {
      const name = typeof request.node.settings.operation === 'string' ? request.node.settings.operation : '';
      const run = services.operations?.[name];
      if (!run) throw new Error(`"${name}" is not an operation this worker can run`);
      const hidden = await services.hidden?.(request.run.launch.ownerId);
      if (hidden?.operations.has(name)) {
        const extension = name.split('.')[0];
        throw new Error(`"${name}" comes from the ${extension} extension, which is switched off for you — switch it on to run this`);
      }
      return run(request);
    }),
  ];
}
