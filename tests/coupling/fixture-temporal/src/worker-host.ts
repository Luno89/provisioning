import { Count, Greet } from './activities/greet.js';
import { Ready } from './activities/ready-host.js';
import { Worker } from './temporal.js';

export const worker = Worker.create({ activities: { Greet, Count, Ready } });
