import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { afterAll, beforeAll } from 'vitest';
import { startTestTemporal, type TestTemporal, type TestTemporalServer } from '@koala/engine-core/testing/temporal';
import { makeCertificates, type TestCertificates } from '@koala/engine-core/testing/temporal-tls';

export interface TemporalWorld {
  env: TestTemporal;
  rootDir: string;
  certificates: TestCertificates;
  front: { address: string };
}

interface MachinePayloadsAnswer {
  ring: { current: string };
  temporal: { address: string; namespace: string; ca: string; serverName: string };
}

export function temporalBehindTls(prefix: string): TemporalWorld {
  const world = {} as TemporalWorld;
  let server: TestTemporalServer | undefined;
  beforeAll(async () => {
    world.certificates = makeCertificates();
    server = await startTestTemporal(world.certificates);
    world.env = server.env;
    world.front = { address: server.tlsAddress };
    world.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  });
  afterAll(async () => {
    await server?.close();
    await fs.rm(world.rootDir, { recursive: true, force: true });
  });
  return world;
}

const machinePayloadsAnswer = (world: TemporalWorld, key: string): MachinePayloadsAnswer => ({
  ring: { current: key },
  temporal: { address: world.front.address, namespace: 'default', ca: world.certificates.ca, serverName: world.certificates.serverName },
});

export interface KoalaAnswering {
  at: string;
  key: string;
  connected?: (socket: Socket) => void;
  asked?: () => void;
}

export async function koalaAnsweringPayloads(world: TemporalWorld, answering: KoalaAnswering): Promise<{ koala: Server; port: number }> {
  const http = createServer();
  const koala = new Server(http);
  koala.of(answering.at).on('connection', (socket) => {
    answering.connected?.(socket);
    socket.on('machine:payloads', (_payload: unknown, ack: (answer: unknown) => void) => {
      answering.asked?.();
      ack(machinePayloadsAnswer(world, answering.key));
    });
  });
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  const { port } = http.address() as { port: number };
  return { koala, port };
}
