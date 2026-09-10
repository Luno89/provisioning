import http from 'http';
import net from 'net';

export interface EgressRule {
  host: string;
  ports?: number[];
}

function normalizeIp(addr: string | undefined): string {
  if (!addr) return '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

function isAllowed(rules: readonly EgressRule[], host: string, port: number): boolean {
  return rules.some((r) => r.host === host && (!r.ports?.length || r.ports.includes(port)));
}

/**
 * A minimal CONNECT-only forward proxy with a per-source-IP hostname allowlist, plus a small
 * loopback-only control API the host `local-agent` process uses to set/clear that allowlist as
 * leaf containers come and go. Runs as its own container, dual-homed onto the default bridge (for
 * real internet access) and each leaf's `--internal` network (for none) — the workspace container
 * has this proxy as its only route out, so the allowlist here is what's actually enforced, not
 * advisory.
 */
export type UpstreamConnector = (port: number, host: string, onConnect: () => void) => net.Socket;

export class EgressProxy {
  private allowlists = new Map<string, EgressRule[]>();
  private proxyServer: http.Server;
  private controlServer: http.Server;

  /** `connectUpstream` is injectable so tests can exercise the allow/deny path without a real network call. */
  constructor(private connectUpstream: UpstreamConnector = net.connect) {
    this.proxyServer = http.createServer((_req, res) => {
      res.writeHead(405);
      res.end('This proxy only handles CONNECT.');
    });

    this.proxyServer.on('connect', (req, clientDuplex, head) => {
      const clientSocket = clientDuplex as net.Socket;
      const sourceIp = normalizeIp(clientSocket.remoteAddress);
      const [host, portStr] = (req.url ?? '').split(':');
      const port = Number(portStr) || 443;

      const rules = this.allowlists.get(sourceIp);
      if (!host || !rules || !isAllowed(rules, host, port)) {
        clientSocket.end(`HTTP/1.1 403 Forbidden\r\n\r\nNot on this project's egress allowlist: ${host ?? '(unknown host)'}\r\n`);
        return;
      }

      const upstream = this.connectUpstream(port, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });

      upstream.on('error', () => clientSocket.end());
      clientSocket.on('error', () => upstream.end());
    });

    this.controlServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          if (req.method === 'POST' && req.url === '/allowlist') {
            const { containerIp, rules } = JSON.parse(body) as { containerIp: string; rules: EgressRule[] };
            this.setAllowlist(containerIp, rules);
            res.writeHead(200); res.end('ok');
            return;
          }
          if (req.method === 'DELETE' && req.url?.startsWith('/allowlist/')) {
            this.clearAllowlist(decodeURIComponent(req.url.slice('/allowlist/'.length)));
            res.writeHead(200); res.end('ok');
            return;
          }
          res.writeHead(404); res.end('not found');
        } catch (err) {
          res.writeHead(400); res.end(err instanceof Error ? err.message : String(err));
        }
      });
    });
  }

  setAllowlist(containerIp: string, rules: readonly EgressRule[]): void {
    this.allowlists.set(normalizeIp(containerIp), [...rules]);
  }

  clearAllowlist(containerIp: string): void {
    this.allowlists.delete(normalizeIp(containerIp));
  }

  /**
   * Both servers bind 0.0.0.0 — when this runs inside a container, a bind to literal 127.0.0.1
   * would only be reachable from inside the container's own network namespace, which defeats
   * Docker's `-p 127.0.0.1:<port>:<port>` publishing (that maps the *host's* loopback to the
   * container's external interface, not to the container's own 127.0.0.1). The loopback-only
   * restriction on the control port is enforced by that host-side publish flag instead.
   */
  async listen(proxyPort: number, controlPort: number): Promise<void> {
    await new Promise<void>((resolve) => this.proxyServer.listen(proxyPort, '0.0.0.0', resolve));
    await new Promise<void>((resolve) => this.controlServer.listen(controlPort, '0.0.0.0', resolve));
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.proxyServer.close(() => resolve()));
    await new Promise<void>((resolve) => this.controlServer.close(() => resolve()));
  }
}

const isMain = process.argv[1]?.endsWith('egress-proxy.ts') || process.argv[1]?.endsWith('egress-proxy.js');
if (isMain) {
  const proxyPort = Number(process.env.PROXY_PORT ?? 38080);
  const controlPort = Number(process.env.CONTROL_PORT ?? 38081);
  const proxy = new EgressProxy();
  proxy.listen(proxyPort, controlPort).then(() => {
    console.log(`[egress-proxy] listening — proxy :${proxyPort}, control (loopback only) :${controlPort}`);
  });
}
