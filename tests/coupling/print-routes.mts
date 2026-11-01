import { bootstrap } from '../../apps/backend/src/index.js';
import { routesOf } from './http-edges.js';

const started = await bootstrap();
process.stdout.write(`KOALA-ROUTES ${JSON.stringify(routesOf(started.app as unknown as Parameters<typeof routesOf>[0]))}\n`);
process.exit(0);
