import http from 'node:http';

export function serveHealth(port: number, ready: () => boolean): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    const ok = ready();
    res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' }).end(ok ? 'ok' : 'starting');
  });
  server.listen(port, '0.0.0.0');
  return server;
}

export function healthPort(env: Readonly<Record<string, string | undefined>>): number | undefined {
  const port = Number(env.HEALTH_PORT);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}
