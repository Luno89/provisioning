import fs from 'fs';
import path from 'path';
import { DefaultLogger, type LogEntry } from '@temporalio/worker';

export type WorkerLogger = DefaultLogger & { keepIn(dataDir: string): void };

export function createWorkerLogger(name: string): WorkerLogger {
  let stream: fs.WriteStream | undefined;
  const logger = new DefaultLogger('INFO', (entry: LogEntry) => {
    const time = new Date(Number(entry.timestampNanos / 1_000_000n)).toISOString();
    const meta = entry.meta ? ` ${JSON.stringify(entry.meta)}` : '';
    const line = `${time} [${entry.level}] ${entry.message}${meta}`;
    console.error(line);
    stream?.write(`${line}\n`);
  });
  return Object.assign(logger, {
    keepIn(dataDir: string): void {
      if (stream) return;
      const logDir = path.join(dataDir, 'logs', 'workers');
      fs.mkdirSync(logDir, { recursive: true });
      stream = fs.createWriteStream(path.join(logDir, `${name}.log`), { flags: 'a' });
    },
  });
}
