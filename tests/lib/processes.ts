import { spawnedProcesses, withEnvironment } from '@koala/engine-core/node-processes';

export const here = spawnedProcesses(withEnvironment(process.env));
