import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { TestWorkflowEnvironment, type LocalTestWorkflowEnvironmentOptions } from '@temporalio/testing';
import { Server, type Socket } from 'socket.io';
import { afterAll, beforeAll } from 'vitest';
import { makeCertificates, tlsInFrontOf, type TestCertificates } from './temporal-tls.js';

export interface TemporalWorld {
  env: TestWorkflowEnvironment;
  rootDir: string;
  certificates: TestCertificates;
  front: { address: string; close(): Promise<void> };
}

interface MachinePayloadsAnswer {
  ring: { current: string };
  temporal: { address: string; namespace: string; ca: string; serverName: string };
}

export function temporalBehindTls(prefix: string, local: LocalTestWorkflowEnvironmentOptions = {}): TemporalWorld {
  const world = {} as TemporalWorld;
  beforeAll(async () => {
    world.env = await TestWorkflowEnvironment.createLocal(local);
    world.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    world.certificates = makeCertificates();
    world.front = await tlsInFrontOf(world.env.address, world.certificates);
  });
  afterAll(async () => {
    await world.front.close();
    await world.env.teardown();
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
