import { Ready } from './activities/ready-cluster.js';
import { Worker } from './temporal.js';

export const worker = Worker.create({ activities: { Ready } });
