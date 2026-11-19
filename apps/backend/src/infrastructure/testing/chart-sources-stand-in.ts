import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TOOLS } from './real-k3s.js';

export interface ChartSourcesStandIn {
  url: string;
  publish(chart: string, repository?: string): void;
  close(): Promise<void>;
}

export function chartFolder(files: Readonly<Record<string, string>>): string {
  const chart = mkdtempSync(join(tmpdir(), 'koala-stand-in-chart-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(chart, file)), { recursive: true });
    writeFileSync(join(chart, file), content);
  }
  return chart;
}

export async function chartSourcesStandIn(): Promise<ChartSourcesStandIn> {
  const served = mkdtempSync(join(tmpdir(), 'koala-chart-sources-'));
  const server = createServer((req, res) => {
    readFile(join(served, decodeURIComponent((req.url ?? '/').slice(1)))).then((body) => res.end(body), () => { res.statusCode = 404; res.end(); });
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    publish: (chart, repository = '') => {
      const path = repository.replace(/^https:\/\//, '');
      const folder = join(served, path);
      mkdirSync(folder, { recursive: true });
      execFileSync(TOOLS.helm, ['package', chart, '--destination', folder]);
      execFileSync(TOOLS.helm, ['repo', 'index', folder, '--url', path ? `${url}/${path}` : url]);
    },
    close: () => new Promise((closed) => { server.close(() => closed()); }),
  };
}
