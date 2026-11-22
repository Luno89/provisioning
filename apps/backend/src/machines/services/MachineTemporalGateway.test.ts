import { EventEmitter } from 'node:events';
import type http2 from 'node:http2';
import { constants } from 'node:http2';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { temporal } from '@temporalio/proto';
import { frame, sealToken, unframe, unsealToken, WORKFLOW_SERVICE } from '../lib/temporal-gateway.js';
import { MachineTemporalGateway, type MachineTemporalGatewayDeps } from './MachineTemporalGateway.js';

const ws = temporal.api.workflowservice.v1;
const bytes = (encoded: { finish(): Uint8Array }): Buffer => Buffer.from(encoded.finish());

type Headers = http2.IncomingHttpHeaders;

class FakeMachineSession extends EventEmitter {
  closed = false;
  destroyed = false;

  close(): void {
    this.closed = true;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

class FakeStream extends EventEmitter {
  closed = false;
  constructor(readonly session: FakeMachineSession = new FakeMachineSession()) {
    super();
  }

  headersSent = false;
  readonly responded: Array<{ headers: http2.OutgoingHttpHeaders; options: http2.ServerStreamResponseOptions | undefined }> = [];
  readonly trailers: http2.OutgoingHttpHeaders[] = [];
  ended: Buffer | undefined;

  respond(headers: http2.OutgoingHttpHeaders, options?: http2.ServerStreamResponseOptions): void {
    this.headersSent = true;
    this.responded.push({ headers, options });
  }

  sendTrailers(trailers: http2.OutgoingHttpHeaders): void {
    this.trailers.push(trailers);
  }

  end(body?: Buffer): void {
    this.ended = body;
    this.emit('wantTrailers');
  }

  refusal(): string | undefined {
    const headers = this.responded[0]?.headers;
    return headers?.['grpc-status'] === undefined ? undefined : `${String(headers['grpc-status'])}: ${String(headers['grpc-message'])}`;
  }

  sent(message: Buffer, ended = true): void {
    this.emit('data', frame(message));
    if (ended) this.emit('end');
  }
}

interface Upstream { headers?: Headers; trailers?: Headers; body?: Buffer; fail?: Error; hold?: boolean }

class FakeUpstreamRequest extends EventEmitter {
  closed = false;
  readonly closedWith: number[] = [];
  received: Buffer | undefined;

  constructor(private readonly answer: Upstream) {
    super();
  }

  end(body: Buffer): void {
    this.received = body;
    if (!this.answer.hold) setImmediate(() => this.finish());
  }

  finish(): void {
    if (this.answer.fail) {
      this.emit('error', this.answer.fail);
      return;
    }
    this.emit('response', this.answer.headers ?? {});
    if (this.answer.body) this.emit('data', this.answer.body);
    if (this.answer.trailers) this.emit('trailers', this.answer.trailers);
    this.emit('end');
  }

  close(code: number): void {
    this.closedWith.push(code);
  }
}

class FakeSession extends EventEmitter {
  closed = false;
  destroyed = false;
  readonly requests: Array<{ headers: http2.OutgoingHttpHeaders; request: FakeUpstreamRequest }> = [];
  answer: Upstream = { headers: { ':status': '200' }, trailers: { 'grpc-status': '0' } };

  request(headers: http2.OutgoingHttpHeaders): FakeUpstreamRequest {
    const request = new FakeUpstreamRequest(this.answer);
    this.requests.push({ headers, request });
    return request;
  }

  close(): void {
    this.closed = true;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

const asStream = (stream: FakeStream) => stream as unknown as http2.ServerHttp2Stream;

const SYSTEM_INFO = `${WORKFLOW_SERVICE}GetSystemInfo`;
const POLL = `${WORKFLOW_SERVICE}PollActivityTaskQueue`;
const poll = (queue: string, namespace = 'default') => bytes(ws.PollActivityTaskQueueRequest.encode({ namespace, taskQueue: { name: queue }, identity: 'w' }));

let session: FakeSession;
let connected: Array<{ authority: string; options: http2.SecureClientSessionOptions | undefined }>;
let log: string[];
let handed: Array<[string, string]>;
let admissions: string[];
let clock: number;
const MACHINE_TOKENS: Record<string, { id: string; until: number }> = {
  'token-d1': { id: 'd1', until: 60_000 },
  'token-d1-fresh': { id: 'd1', until: 600_000 },
  'token-d2': { id: 'd2', until: 600_000 },
};

const gateway = (over: Partial<MachineTemporalGatewayDeps> = {}) => new MachineTemporalGateway({
  upstream: 'temporal:7233',
  upstreamKey: () => 'the-gateway-token',
  tls: { cert: 'the-gateway-certificate', key: 'the-gateway-key' },
  namespace: 'default',
  keys: () => ['the-key'],
  admit: async (token) => {
    admissions.push(token);
    const known = MACHINE_TOKENS[token];
    return known ? { device: { id: known.id }, until: known.until } : 'Unauthorized: the machine\'s token could not be checked: not root\'s';
  },
  now: () => clock,
  handed: async (workflowId, deviceId) => { handed.push([workflowId, deviceId]); },
  log: (line) => log.push(line),
  connect: (authority, options) => {
    connected.push({ authority, options });
    return session as unknown as http2.ClientHttp2Session;
  },
  ...over,
});

async function call(machine: MachineTemporalGateway, headers: Headers, message?: Buffer, on?: FakeMachineSession) {
  const stream = new FakeStream(on);
  const handling = machine.handle(asStream(stream), headers);
  if (message) stream.sent(message);
  await handling;
  return stream;
}

const asMachine = (path: string, extra: Headers = {}): Headers => ({ ':path': path, authorization: 'Bearer token-d1', 'content-type': 'application/grpc', te: 'trailers', 'x-not-forwarded': 'no', ...extra });

beforeEach(() => {
  session = new FakeSession();
  connected = [];
  log = [];
  handed = [];
  admissions = [];
  clock = 0;
});

describe('a machine reaching Temporal through the gateway', () => {
  it('forwards a call a machine may make under the gateway\'s own token, with only the headers a gRPC call needs, and answers with what Temporal said', async () => {
    session.answer = { headers: { ':status': '200', 'content-type': 'application/grpc' }, body: frame(Buffer.from('reply')), trailers: { 'grpc-status': '0', 'x-trailer': 'kept' } };
    const stream = await call(gateway(), asMachine(SYSTEM_INFO), Buffer.alloc(0));

    const { headers, request } = session.requests[0]!;
    expect(headers).toEqual({ ':method': 'POST', ':path': SYSTEM_INFO, authorization: 'Bearer the-gateway-token', 'content-type': 'application/grpc', te: 'trailers' });
    expect(request.received).toEqual(frame(Buffer.alloc(0)));
    expect(stream.responded).toEqual([{ headers: { ':status': 200, 'content-type': 'application/grpc' }, options: { waitForTrailers: true } }]);
    expect(stream.trailers).toEqual([{ 'grpc-status': '0', 'x-trailer': 'kept' }]);
    expect(stream.ended).toEqual(frame(Buffer.from('reply')));
  });

  it('refuses a call that is not an activity worker\'s with an unimplemented status', async () => {
    const stream = await call(gateway(), asMachine(`${WORKFLOW_SERVICE}ListWorkflowExecutions`), Buffer.alloc(0));
    expect(stream.responded).toEqual([{
      headers: { ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '12', 'grpc-message': 'a machine asks Temporal only for its own work' },
      options: { endStream: true },
    }]);
    expect(session.requests).toEqual([]);
    expect(admissions).toEqual([]);
  });

  it('refuses a machine that sends no token, or one root did not give it for this Koala, as unauthenticated, saying why', async () => {
    const none = await call(gateway(), asMachine(SYSTEM_INFO, { authorization: undefined }), Buffer.alloc(0));
    expect(none.refusal()).toBe('16: Unauthorized: send a token root gave this machine for this Koala');
    const stranger = await call(gateway(), asMachine(SYSTEM_INFO, { authorization: 'Bearer who-is-this' }), Buffer.alloc(0));
    expect(stranger.refusal()).toBe('16: Unauthorized: the machine\'s token could not be checked: not root\'s');
    expect(stranger.session.closed).toBe(false);
    expect(session.requests).toEqual([]);
  });

  it('checks a token once on a connection, again on another connection, and again when the machine sends a fresh one', async () => {
    const machine = gateway();
    const desk = new FakeMachineSession();
    await call(machine, asMachine(SYSTEM_INFO), Buffer.alloc(0), desk);
    await call(machine, asMachine(SYSTEM_INFO), Buffer.alloc(0), desk);
    expect(admissions).toEqual(['token-d1']);
    await call(machine, asMachine(SYSTEM_INFO), Buffer.alloc(0));
    expect(admissions).toEqual(['token-d1', 'token-d1']);
    await call(machine, asMachine(SYSTEM_INFO, { authorization: 'Bearer token-d1-fresh' }), Buffer.alloc(0), desk);
    expect(admissions).toEqual(['token-d1', 'token-d1', 'token-d1-fresh']);
    expect(session.requests).toHaveLength(4);
  });

  it('refuses the first call on a connection once its token ended and cuts that connection', async () => {
    const machine = gateway();
    const desk = new FakeMachineSession();
    expect((await call(machine, asMachine(SYSTEM_INFO), Buffer.alloc(0), desk)).refusal()).toBeUndefined();
    clock = 60_000;
    const late = await call(machine, asMachine(SYSTEM_INFO), Buffer.alloc(0), desk);
    expect(late.refusal()).toBe('16: Unauthorized: this machine\'s token from root ended; it takes a fresh one and connects again');
    expect(desk.closed).toBe(true);
    expect(session.requests).toHaveLength(1);
  });

  it('keeps a connection past its first token once the machine sends a fresh one, until that one ends too', async () => {
    const machine = gateway();
    const desk = new FakeMachineSession();
    await call(machine, asMachine(SYSTEM_INFO), Buffer.alloc(0), desk);
    clock = 60_000;
    expect((await call(machine, asMachine(SYSTEM_INFO, { authorization: 'Bearer token-d1-fresh' }), Buffer.alloc(0), desk)).refusal()).toBeUndefined();
    expect(desk.closed).toBe(false);
    clock = 600_000;
    expect((await call(machine, asMachine(SYSTEM_INFO, { authorization: 'Bearer token-d1-fresh' }), Buffer.alloc(0), desk)).refusal()).toMatch(/^16: /);
    expect(desk.closed).toBe(true);
  });

  it('cuts a connection whose next token is another machine\'s or not root\'s', async () => {
    for (const next of ['token-d2', 'who-is-this']) {
      const machine = gateway();
      const desk = new FakeMachineSession();
      await call(machine, asMachine(SYSTEM_INFO), Buffer.alloc(0), desk);
      expect((await call(machine, asMachine(SYSTEM_INFO, { authorization: `Bearer ${next}` }), Buffer.alloc(0), desk)).refusal()).toMatch(/^16: /);
      expect(desk.closed).toBe(true);
    }
  });

  it('cuts every connection of a machine it is told is gone, and no other machine\'s', async () => {
    const machine = gateway();
    const desk = new FakeMachineSession();
    const other = new FakeMachineSession();
    await call(machine, asMachine(SYSTEM_INFO), Buffer.alloc(0), desk);
    await call(machine, asMachine(SYSTEM_INFO, { authorization: 'Bearer token-d2' }), Buffer.alloc(0), other);
    machine.forget('d1');
    expect(desk.destroyed).toBe(true);
    expect(other.destroyed).toBe(false);
  });

  it('refuses, saying why and logging it, a poll of another machine\'s queue or in another namespace', async () => {
    const other = await call(gateway(), asMachine(POLL), poll('device-d2'));
    expect(other.responded[0]!.headers).toMatchObject({ 'grpc-status': '7', 'grpc-message': 'a machine takes work only from its own queue, device-d1' });
    expect(log).toEqual(['[machine-gateway] refused PollActivityTaskQueue from d1: a machine takes work only from its own queue, device-d1']);
    const elsewhere = await call(gateway(), asMachine(POLL), poll('device-d1', 'other'));
    expect(elsewhere.responded[0]!.headers).toMatchObject({ 'grpc-status': '7', 'grpc-message': 'a machine works only in the namespace default' });
    expect(session.requests).toEqual([]);
  });

  it('seals the task token of a task it hands a machine and tells which workflow it was handed from', async () => {
    const task = bytes(ws.PollActivityTaskQueueResponse.encode({ taskToken: Buffer.from('temporal-token'), workflowExecution: { workflowId: 'run-7', runId: 'r' }, activityId: '1' }));
    session.answer = { headers: { ':status': '200' }, body: frame(task), trailers: { 'grpc-status': '0' } };
    const stream = await call(gateway(), asMachine(POLL), poll('device-d1'));

    expect(handed).toEqual([['run-7', 'd1']]);
    const answered = ws.PollActivityTaskQueueResponse.decode(unframe(stream.ended!, undefined));
    expect(unsealToken(Buffer.from(answered.taskToken), 'd1', ['the-key'])).toEqual(Buffer.from('temporal-token'));
    expect(answered.activityId).toBe('1');
  });

  it('forwards an answer on a task with Temporal\'s own token in place of the seal', async () => {
    const complete = bytes(ws.RespondActivityTaskCompletedRequest.encode({ taskToken: sealToken(Buffer.from('temporal-token'), 'd1', 'the-key'), namespace: 'default', identity: 'w' }));
    await call(gateway(), asMachine(`${WORKFLOW_SERVICE}RespondActivityTaskCompleted`), complete);
    const forwarded = ws.RespondActivityTaskCompletedRequest.decode(unframe(session.requests[0]!.request.received!, undefined));
    expect(Buffer.from(forwarded.taskToken)).toEqual(Buffer.from('temporal-token'));

    const forged = bytes(ws.RespondActivityTaskCompletedRequest.encode({ taskToken: Buffer.from('forged'), namespace: 'default' }));
    const refused = await call(gateway(), asMachine(`${WORKFLOW_SERVICE}RespondActivityTaskCompleted`), forged);
    expect(refused.responded[0]!.headers).toMatchObject({ 'grpc-status': '7', 'grpc-message': 'a machine answers only for the tasks it was handed' });
  });

  it('passes an empty poll on as it came, handing no workflow to anyone', async () => {
    session.answer = { headers: { ':status': '200' }, trailers: { 'grpc-status': '0' } };
    const stream = await call(gateway(), asMachine(POLL), poll('device-d1'));
    expect(handed).toEqual([]);
    expect(stream.ended).toEqual(Buffer.alloc(0));
  });

  it('takes the status from the response headers when Temporal sends it there, and keeps its other fields apart from the pseudo-headers', async () => {
    session.answer = { headers: { ':status': '200', 'grpc-status': '5', 'grpc-message': 'not found', 'content-type': 'application/grpc' } };
    const stream = await call(gateway(), asMachine(SYSTEM_INFO), Buffer.alloc(0));
    expect(stream.responded[0]!.headers).toEqual({ ':status': 200, 'content-type': 'application/grpc' });
    expect(stream.trailers).toEqual([{ 'grpc-status': '5', 'grpc-message': 'not found' }]);
  });

  it('says Temporal ended the call without saying how when it gave no status', async () => {
    session.answer = { headers: { ':status': '200' } };
    const stream = await call(gateway(), asMachine(SYSTEM_INFO), Buffer.alloc(0));
    expect(stream.trailers).toEqual([{ 'grpc-status': '14', 'grpc-message': 'Temporal ended the call without saying how' }]);
  });

  it('says the gateway could not reach Temporal when the call fails, escaping anything a header cannot carry', async () => {
    session.answer = { fail: new Error('reset: café 100%') };
    const stream = await call(gateway(), asMachine(SYSTEM_INFO), Buffer.alloc(0));
    expect(stream.responded[0]!.headers).toMatchObject({ 'grpc-status': '14', 'grpc-message': 'the machine gateway could not reach Temporal: reset: caf%C3%A9 100%25' });
  });

  it('says so when what the machine sent cannot be read', async () => {
    const stream = new FakeStream();
    const handling = gateway().handle(asStream(stream), asMachine(SYSTEM_INFO));
    stream.emit('error', new Error('stream reset'));
    await handling;
    expect(stream.responded[0]!.headers).toMatchObject({ 'grpc-status': '14' });
  });

  it('says nothing more when the machine hung up before Temporal answered, and cancels the call it made', async () => {
    session.answer = { headers: { ':status': '200' }, trailers: { 'grpc-status': '0' }, hold: true };
    const stream = new FakeStream();
    const handling = gateway().handle(asStream(stream), asMachine(SYSTEM_INFO));
    stream.sent(Buffer.alloc(0));
    await vi.waitFor(() => expect(session.requests).toHaveLength(1));
    stream.closed = true;
    stream.emit('close');
    session.requests[0]!.request.finish();
    await handling;
    expect(session.requests[0]!.request.closedWith).toEqual([constants.NGHTTP2_CANCEL]);
    expect(stream.responded).toEqual([]);
  });

  it('does not cancel a call that has already ended when the machine hangs up', async () => {
    const stream = await call(gateway(), asMachine(SYSTEM_INFO), Buffer.alloc(0));
    session.requests[0]!.request.closed = true;
    stream.emit('close');
    expect(session.requests[0]!.request.closedWith).toEqual([]);
  });

  it('keeps one connection to Temporal while it lasts and makes another once it has closed', async () => {
    const machine = gateway();
    await call(machine, asMachine(SYSTEM_INFO), Buffer.alloc(0));
    await call(machine, asMachine(SYSTEM_INFO), Buffer.alloc(0));
    expect(connected).toEqual([{ authority: 'http://temporal:7233', options: undefined }]);
    session.closed = true;
    session = new FakeSession();
    await call(machine, asMachine(SYSTEM_INFO), Buffer.alloc(0));
    expect(connected).toHaveLength(2);
  });

  it('reaches Temporal over TLS to a certificate of the install\'s own when it has one, and logs when the connection breaks', async () => {
    const ca = Buffer.from('ca');
    const machine = gateway({ upstreamCa: ca });
    await call(machine, asMachine(SYSTEM_INFO), Buffer.alloc(0));
    expect(connected).toEqual([{ authority: 'https://temporal:7233', options: { ca } }]);
    session.emit('error', new Error('ECONNRESET'));
    expect(log).toEqual(['[machine-gateway] Temporal connection: ECONNRESET']);
  });
});

describe('the gateway\'s listening', () => {
  type Server = http2.Http2SecureServer;

  const served = () => {
    const server = mock<Server>();
    const handlers = new Map<string, (...args: never[]) => void>();
    server.on.mockImplementation(((event: string, handler: (...args: never[]) => void) => { handlers.set(event, handler); return server; }) as never);
    server.listen.mockImplementation(((_port: number, _host: string, ready: () => void) => { ready(); return server; }) as never);
    server.address.mockReturnValue({ port: 7234, address: '127.0.0.1', family: 'IPv4' });
    server.close.mockImplementation(((done: () => void) => { done(); return server; }) as never);
    return { server, handlers };
  };

  it('listens where it is told and says the port it got', async () => {
    const { server } = served();
    const machine = gateway({ createServer: () => server });
    expect(await machine.listen(0, '127.0.0.1')).toBe(7234);
    expect(server.listen).toHaveBeenCalledWith(0, '127.0.0.1', expect.any(Function) as never);
  });

  it('serves each stream a machine opens', async () => {
    const { server, handlers } = served();
    const machine = gateway({ createServer: () => server });
    await machine.listen(0, '127.0.0.1');
    const stream = new FakeStream();
    handlers.get('stream')?.(stream as never, asMachine(`${WORKFLOW_SERVICE}ListWorkflowExecutions`) as never);
    await vi.waitFor(() => expect(stream.responded).toHaveLength(1));
    expect(stream.responded[0]!.headers).toMatchObject({ 'grpc-status': '12' });
  });

  it('fails to listen with the server\'s error', async () => {
    const { server } = served();
    server.listen.mockImplementation((() => server) as never);
    server.once.mockImplementation(((event: string, handler: (err: Error) => void) => { if (event === 'error') handler(new Error('EADDRINUSE')); return server; }) as never);
    await expect(gateway({ createServer: () => server }).listen(7234, '127.0.0.1')).rejects.toThrow('EADDRINUSE');
  });

  it('closes its connection to Temporal and every machine\'s session, then the server', async () => {
    const { server, handlers } = served();
    const machine = gateway({ createServer: () => server });
    await machine.listen(0, '127.0.0.1');
    await call(machine, asMachine(SYSTEM_INFO), Buffer.alloc(0));
    const sessions = [new FakeSession(), new FakeSession()];
    for (const open of sessions) handlers.get('session')?.(open as never);
    sessions[1]!.emit('close');
    await machine.close();
    expect(session.closed).toBe(true);
    expect(sessions[0]!.destroyed).toBe(true);
    expect(sessions[1]!.destroyed).toBe(false);
    expect(server.close).toHaveBeenCalled();
  });

  it('closes cleanly when it never listened', async () => {
    await expect(gateway().close()).resolves.toBeUndefined();
  });
});
