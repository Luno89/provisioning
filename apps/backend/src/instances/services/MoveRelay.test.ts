import type { IncomingMessage } from 'node:http';
import type https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MoveRelay } from './MoveRelay.js';
import { MOVE_TOKEN_HEADER } from '../lib/identity-token.js';

type Options = Parameters<typeof https.request>[0] & { headers: Record<string, string> };

interface Sent { options: Options }

function relayAnswering(answer: { status: number; body: string } | Error, kubeconfig = tokenConfig('https://pool.example:6443')) {
  const sent: Sent[] = [];
  const request = ((options: Options, callback: (response: IncomingMessage) => void) => {
    sent.push({ options });
    const outgoing = new EventEmitter() as EventEmitter & { end: () => void };
    outgoing.end = () => {
      if (answer instanceof Error) {
        outgoing.emit('error', answer);
        return;
      }
      callback(Object.assign(Readable.from([Buffer.from(answer.body)]), { statusCode: answer.status }) as unknown as IncomingMessage);
    };
    return outgoing;
  }) as unknown as typeof https.request;
  const relay = new MoveRelay({ kubeconfig: async () => kubeconfig, sign: (instanceId, part) => `signed-${instanceId}-${part}`, request });
  return { relay, sent };
}

function tokenConfig(server: string, extra = ''): string {
  return `apiVersion: v1\nclusters:\n- name: pool\n  cluster:\n    server: ${server}\n${extra}contexts:\n- name: pool\n  context: { cluster: pool, user: root }\ncurrent-context: pool\nusers:\n- name: root\n  user: { token: api-token }\n`;
}

describe('telling a pool instance its move stopped', () => {
  it('posts the thaw to its backend through the pool node\'s API with a token for that instance and step', async () => {
    const { relay, sent } = relayAnswering({ status: 200, body: '{"thawed":true}' });
    expect(await relay.thaw({ name: 'luno', instanceId: 'inst-1' })).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.options).toMatchObject({
      method: 'POST',
      hostname: 'pool.example',
      port: '6443',
      path: '/api/v1/namespaces/pool-luno/services/http:instance-x-nowrinkles-x-luno:80/proxy/api/move/thaw',
      headers: { [MOVE_TOKEN_HEADER]: 'signed-inst-1-thaw', authorization: 'Bearer api-token' },
    });
  });

  it('says why when the instance refuses, rather than counting any answer as thawed', async () => {
    const { relay } = relayAnswering({ status: 409, body: '{"error":"work is still running"}' });
    expect(await relay.thaw({ name: 'luno', instanceId: 'inst-1' })).toBe('Koala\'s servers answered 409: work is still running');
  });

  it('gives what the instance said when it was not JSON, cut short, or says "no reason given" when it said nothing', async () => {
    expect(await relayAnswering({ status: 502, body: 'bad gateway\n' }).relay.thaw({ name: 'luno', instanceId: 'inst-1' })).toBe('Koala\'s servers answered 502: bad gateway');
    expect(await relayAnswering({ status: 500, body: '' }).relay.thaw({ name: 'luno', instanceId: 'inst-1' })).toBe('Koala\'s servers answered 500: no reason given');
    expect(await relayAnswering({ status: 500, body: '{"detail":"x"}' }).relay.thaw({ name: 'luno', instanceId: 'inst-1' })).toBe('Koala\'s servers answered 500: {"detail":"x"}');
    const long = await relayAnswering({ status: 500, body: 'x'.repeat(1000) }).relay.thaw({ name: 'luno', instanceId: 'inst-1' });
    expect(long?.length).toBe('Koala\'s servers answered 500: '.length + 300);
  });

  it('says why when the pool node cannot be reached', async () => {
    const { relay } = relayAnswering(new Error('connect ECONNREFUSED'));
    expect(await relay.thaw({ name: 'luno', instanceId: 'inst-1' })).toBe('Koala\'s servers could not be reached: connect ECONNREFUSED');
  });
});

describe('opening one part of a pool instance\'s data through the pool node', () => {
  it('asks for the part by name with a token for that part, and hands back the stream', async () => {
    const { relay, sent } = relayAnswering({ status: 200, body: 'bytes' });
    const stream = await relay.open({ name: 'luno', instanceId: 'inst-1' }, 'mongo dump');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks).toString()).toBe('bytes');
    expect(sent[0]!.options).toMatchObject({
      method: 'GET',
      path: '/api/v1/namespaces/pool-luno/services/http:instance-x-nowrinkles-x-luno:80/proxy/api/move/parts/mongo%20dump',
      headers: { [MOVE_TOKEN_HEADER]: 'signed-inst-1-mongo dump' },
    });
  });

  it('presents the credentials the pool node\'s kubeconfig holds, and trusts its authority', async () => {
    const certificate = Buffer.from('CERT').toString('base64');
    const key = Buffer.from('KEY').toString('base64');
    const authority = Buffer.from('CA').toString('base64');
    const config = `apiVersion: v1\nclusters:\n- name: pool\n  cluster:\n    server: https://pool.example\n    certificate-authority-data: ${authority}\ncontexts:\n- name: pool\n  context: { cluster: pool, user: root }\ncurrent-context: pool\nusers:\n- name: root\n  user: { client-certificate-data: ${certificate}, client-key-data: ${key} }\n`;
    const { relay, sent } = relayAnswering({ status: 200, body: '' }, config);
    await relay.open({ name: 'luno', instanceId: 'inst-1' }, 'gitea');
    const options = sent[0]!.options as unknown as Record<string, unknown> & { headers: Record<string, string> };
    expect(options.port).toBe(443);
    expect(String(options.ca)).toBe('CA');
    expect(String(options.cert)).toBe('CERT');
    expect(String(options.key)).toBe('KEY');
    expect(options.headers.authorization).toBeUndefined();
    expect(options.rejectUnauthorized).toBeUndefined();
  });

  it('skips verifying the pool node only where its kubeconfig says to', async () => {
    const { relay, sent } = relayAnswering({ status: 200, body: '' }, tokenConfig('https://pool.example', '    insecure-skip-tls-verify: true\n'));
    await relay.open({ name: 'luno', instanceId: 'inst-1' }, 'gitea');
    expect(sent[0]!.options).toMatchObject({ rejectUnauthorized: false });
  });
});
