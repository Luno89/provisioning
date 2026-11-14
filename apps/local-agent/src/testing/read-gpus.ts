import { hostCluster } from '../machine-cluster.js';
import { machineGpus } from '../machine-gpus.js';

const report = await machineGpus(hostCluster(async () => undefined));
process.stdout.write(`${JSON.stringify(report)}\n`);
