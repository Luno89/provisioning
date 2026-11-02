import http from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';

export interface GitHttpRemote {
  url: string;
  close(): Promise<void>;
}

const HEADER_END = Buffer.from('\r\n\r\n');

export async function gitHttpRemote(root: string, authorization: string): Promise<GitHttpRemote> {
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== authorization) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }).end('git needs a login');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://remote.test');
    const cgi = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: req.method ?? 'GET',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_USER: 'koala',
        REMOTE_ADDR: '127.0.0.1',
        ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) } : {}),
        ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: String(req.headers['git-protocol']) } : {}),
      },
    });
    cgi.stdin.on('error', () => undefined);
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let sent = false;
    cgi.stdout.on('data', (chunk: Buffer) => {
      if (sent) { res.write(chunk); return; }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf(HEADER_END);
      if (end < 0) return;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.subarray(0, end).toString('utf8').split('\r\n')) {
        const [name, ...value] = line.split(':');
        if (name!.toLowerCase() === 'status') status = Number(value.join(':').trim().split(' ')[0]);
        else headers[name!] = value.join(':').trim();
      }
      res.writeHead(status, headers);
      sent = true;
      res.write(head.subarray(end + HEADER_END.length));
    });
    cgi.on('close', () => { if (!sent) res.writeHead(502); res.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
