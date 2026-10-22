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
