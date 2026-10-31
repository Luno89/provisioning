import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { answeringIn, answersThrough, nodePortsOf, probeCommand } from './node-ports.js';

describe('the node ports a cluster hands out', () => {
  it('lists every TCP node port of NodePort and LoadBalancer services, and nothing else', () => {
    expect(nodePortsOf({
      items: [
        { metadata: { namespace: 'traefik', name: 'traefik' }, spec: { type: 'NodePort', ports: [{ nodePort: 31443, protocol: 'TCP' }, { nodePort: 30080 }] } },
        { metadata: { namespace: 'game', name: 'valheim' }, spec: { type: 'NodePort', ports: [{ nodePort: 30456, protocol: 'UDP' }] } },
        { metadata: { namespace: 'default', name: 'kubernetes' }, spec: { type: 'ClusterIP', ports: [{ protocol: 'TCP' }] } },
        { metadata: { namespace: 'x', name: 'lb' }, spec: { type: 'LoadBalancer', ports: [{ nodePort: 32001 }] } },
      ],
    })).toEqual([
      { service: 'traefik/traefik', port: 30080 },
      { service: 'x/lb', port: 32001 },
      { service: 'traefik/traefik', port: 31443 },
    ].sort((a, b) => a.port - b.port));
    expect(nodePortsOf(undefined)).toEqual([]);
  });

  it('reads which ports said something back', () => {
    expect(answeringIn('30080 64\n31443 0\n32001 12\nnoise\n')).toEqual([30080, 32001]);
    expect(probeCommand('100.64.0.1', [30080, 31443])).toMatch(/python3 \/tmp\/node-port-probe\.py 100\.64\.0\.1 30080 31443$/);
  });
});

describe('answersThrough', () => {
  let servers: Server[] = [];
  let sockets: Socket[] = [];
  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise<void>((done) => server.close(() => done()))));
    servers = [];
    sockets = [];
  });
  const listen = async (handler: (socket: Socket) => void) => {
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => undefined);
      handler(socket);
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return (server.address() as AddressInfo).port;
  };

  it('counts a port as answering only when something comes back, as a forward that accepts and then drops says nothing', async () => {
    expect(await answersThrough(await listen((socket) => socket.end('HTTP/1.0 404 Not Found\r\n\r\n')))).toBe(true);
    expect(await answersThrough(await listen((socket) => socket.end()))).toBe(false);
  });
});
