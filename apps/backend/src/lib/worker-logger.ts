/**
 * worker-host.ts/worker-cluster.ts are bare host processes (started via `npm run
 * dev:worker`/`dev:worker:cluster`, or as the in-cluster pod) — their console output only ever
 * reached whichever terminal started them, with no way to inspect it after the fact. This wires
 * a `DefaultLogger` that writes everywhere the SDK's default already does (stderr) *and* appends
 * to a file under data/logs/workers/ — which promtail (see
 * packages/cdktf-infra/constructs/logging.ts) tails on the management cluster, so this shows up
 * in Grafana too.
 *
 * Passing this as `Runtime.install({ logger })` isn't just for our own `logger.info(...)` calls —
 * the Temporal SDK itself automatically logs activity start/complete/fail through this same
 * logger (its own `ActivityInboundLogInterceptor` is deprecated specifically because this
 * became automatic), so this one change is what makes "did an activity even get picked up, and
 * what did it fail with" visible without querying Temporal's raw event history by hand.
 */
import fs from 'fs';
import path from 'path';
import { DefaultLogger, type LogEntry } from '@temporalio/worker';

const LOG_DIR = path.resolve(process.cwd(), 'data/logs/workers');
fs.mkdirSync(LOG_DIR, { recursive: true });

export function createWorkerLogger(name: string): DefaultLogger {
  const stream = fs.createWriteStream(path.join(LOG_DIR, `${name}.log`), { flags: 'a' });

  return new DefaultLogger('INFO', (entry: LogEntry) => {
    const time = new Date(Number(entry.timestampNanos / 1_000_000n)).toISOString();
    const meta = entry.meta ? ` ${JSON.stringify(entry.meta)}` : '';
    const line = `${time} [${entry.level}] ${entry.message}${meta}`;
    console.error(line);
    stream.write(`${line}\n`);
  });
}
