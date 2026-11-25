import http2 from 'node:http2';
import { ignore } from '@koala/engine-core/failures';
import { frame, gatewayCallOf, gatewayDecision, handedWorkflowOf, sealedPollAnswer, unframe } from '../lib/temporal-gateway.js';

export interface MachineTemporalGatewayDeps {
  upstream: string;
  upstreamKey: () => string;
  upstreamCa?: Buffer | undefined;
  namespace: string;
  tls: { cert: Buffer | string; key: Buffer | string };
  keys: () => readonly string[];
  admit: (token: string) => Promise<{ device: { id: string }; until: number } | string>;
  now?: (() => number) | undefined;
  handed: (workflowId: string, deviceId: string) => Promise<void>;
  log?: ((line: string) => void) | undefined;
  createServer?: (() => http2.Http2SecureServer) | undefined;
  connect?: ((authority: string, options?: http2.SecureClientSessionOptions) => http2.ClientHttp2Session) | undefined;
}

const GRPC = { ok: 0, permissionDenied: 7, unimplemented: 12, unavailable: 14, unauthenticated: 16 } as const;
const STATUS_FIELDS = new Set(['grpc-status', 'grpc-message', 'grpc-status-details-bin']);
const FORWARDED = ['content-type', 'te', 'grpc-timeout', 'grpc-accept-encoding', 'user-agent', 'client-name', 'client-version', 'supported-server-versions'];
const NO_TOKEN = 'Unauthorized: send a token root gave this machine for this Koala';
const TOKEN_ENDED = 'Unauthorized: this machine\'s token from root ended; it takes a fresh one and connects again';

interface Admitted {
  deviceId: string;
  token: string;
  until: number;
}

const collect = (readable: NodeJS.ReadableStream): Promise<Buffer> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  readable.on('data', (chunk: Buffer) => chunks.push(chunk));
  readable.on('end', () => resolve(Buffer.concat(chunks)));
  readable.on('error', reject);
});

const header = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

const grpcMessage = (message: string): string =>
  [...Buffer.from(message, 'utf8')].map((byte) => (byte >= 0x20 && byte <= 0x7e && byte !== 0x25 ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)).join('');

function refuse(stream: http2.ServerHttp2Stream, status: number, message: string): void {
  if (stream.closed || stream.headersSent) return;
  stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': String(status), 'grpc-message': grpcMessage(message) }, { endStream: true });
}

export class MachineTemporalGateway {
  private server: http2.Http2SecureServer | undefined;
  private session: http2.ClientHttp2Session | undefined;
  private readonly admitted = new Map<http2.Http2Session, Admitted>();
  private readonly sessions = new Set<http2.ServerHttp2Session>();

  constructor(private readonly deps: MachineTemporalGatewayDeps) {}

  listen(port: number, host: string): Promise<number> {
    const server = (this.deps.createServer ?? (() => http2.createSecureServer({ cert: this.deps.tls.cert, key: this.deps.tls.key })))();
    server.on('stream', (stream, headers) => { void this.handle(stream, headers); });
    server.on('session', (session) => {
      this.sessions.add(session);
      session.once('close', () => this.sessions.delete(session));
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve((server.address() as { port: number }).port));
    });
  }

  async close(): Promise<void> {
    this.session?.close();
    for (const session of this.sessions) session.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private upstream(): http2.ClientHttp2Session {
    if (!this.session || this.session.closed || this.session.destroyed) {
      const connect = this.deps.connect ?? ((authority, options) => http2.connect(authority, options));
      const session = this.deps.upstreamCa
        ? connect(`https://${this.deps.upstream}`, { ca: this.deps.upstreamCa })
        : connect(`http://${this.deps.upstream}`);
      session.on('error', (err: Error) => this.deps.log?.(`[machine-gateway] Temporal connection: ${err.message}`));
      this.session = session;
    }
    return this.session;
  }

  forget(deviceId: string): void {
    for (const [session, entry] of this.admitted) {
      if (entry.deviceId !== deviceId) continue;
      this.admitted.delete(session);
      session.destroy();
    }
  }

  private async deviceFor(session: http2.Http2Session, token: string): Promise<{ deviceId: string } | { refused: string }> {
    const known = this.admitted.get(session);
    const now = (this.deps.now ?? Date.now)();
    if (known && known.token === token) return now < known.until ? { deviceId: known.deviceId } : { refused: TOKEN_ENDED };
    if (!token) return { refused: NO_TOKEN };
    const admission = await this.deps.admit(token);
    if (typeof admission === 'string') return { refused: admission };
    if (known && known.deviceId !== admission.device.id) return { refused: 'Unauthorized: this connection is another machine\'s' };
    if (now >= admission.until) return { refused: TOKEN_ENDED };
    if (session.destroyed) return { refused: 'this machine was cut off here' };
    if (!known) session.once('close', () => this.admitted.delete(session));
    this.admitted.set(session, { deviceId: admission.device.id, token, until: admission.until });
    return { deviceId: admission.device.id };
  }

  async handle(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders): Promise<void> {
    try {
      const path = header(headers[':path']) ?? '';
      const call = gatewayCallOf(path);
      if (!call) return refuse(stream, GRPC.unimplemented, 'a machine asks Temporal only for its own work');
      const received = collect(stream);
      received.catch(ignore('what the machine sent is awaited below when its call goes on; a call refused before that has no use for it'));
      const token = (header(headers.authorization) ?? '').replace(/^Bearer\s+/i, '');
      const { session } = stream;
      let admitted: { deviceId: string } | { refused: string };
      try {
        admitted = session ? await this.deviceFor(session, token) : { refused: 'this machine\'s connection had already closed' };
      } catch (err) {
        return refuse(stream, GRPC.unavailable, (err as Error).message);
      }
      if ('refused' in admitted) {
        refuse(stream, GRPC.unauthenticated, admitted.refused);
        if (session && this.admitted.delete(session)) session.close();
        return undefined;
      }
      const { deviceId } = admitted;
      const keys = this.deps.keys();
      const decision = gatewayDecision(call, unframe(await received, header(headers['grpc-encoding'])), { deviceId, namespace: this.deps.namespace, keys });
      if ('refused' in decision) {
        this.deps.log?.(`[machine-gateway] refused ${call} from ${deviceId}: ${decision.refused}`);
        return refuse(stream, GRPC.permissionDenied, decision.refused);
      }

      const forwarded: http2.OutgoingHttpHeaders = { ':method': 'POST', ':path': path, authorization: `Bearer ${this.deps.upstreamKey()}` };
      for (const name of FORWARDED) if (headers[name] !== undefined) forwarded[name] = headers[name];
      const up = this.upstream().request(forwarded);
      stream.on('close', () => { if (!up.closed) up.close(http2.constants.NGHTTP2_CANCEL); });
      up.end(frame(decision.forward));

      const [response, body, trailers] = await new Promise<[http2.IncomingHttpHeaders, Buffer, http2.IncomingHttpHeaders]>((resolve, reject) => {
        let answered: http2.IncomingHttpHeaders = {};
        let ended: http2.IncomingHttpHeaders = {};
        const chunks: Buffer[] = [];
        up.on('response', (h: http2.IncomingHttpHeaders) => { answered = h; });
        up.on('trailers', (t: http2.IncomingHttpHeaders) => { ended = t; });
        up.on('data', (chunk: Buffer) => chunks.push(chunk));
        up.on('end', () => resolve([answered, Buffer.concat(chunks), ended]));
        up.on('error', reject);
      });
      if (stream.closed) return;
      const status = header(trailers['grpc-status']) ?? header(response['grpc-status']);
      const task = call === 'PollActivityTaskQueue' && status === String(GRPC.ok) && body.length > 0 ? unframe(body, header(response['grpc-encoding'])) : undefined;
      const workflowId = task ? handedWorkflowOf(task) : undefined;
      if (workflowId) await this.deps.handed(workflowId, deviceId);
      const sealed = task ? frame(sealedPollAnswer(task, deviceId, keys[0]!)) : body;
      const own = (from: http2.IncomingHttpHeaders) => Object.fromEntries(Object.entries(from).filter(([name]) => !name.startsWith(':')));
      const statusOf = (from: http2.IncomingHttpHeaders) => Object.fromEntries(Object.entries(own(from)).filter(([name]) => STATUS_FIELDS.has(name)));
      const rest = Object.fromEntries(Object.entries(own(response)).filter(([name]) => !STATUS_FIELDS.has(name)));
      const ending = { ...statusOf(response), ...statusOf(trailers), ...Object.fromEntries(Object.entries(own(trailers)).filter(([name]) => !STATUS_FIELDS.has(name))) };
      stream.respond({ ':status': 200, ...rest }, { waitForTrailers: true });
      stream.once('wantTrailers', () => stream.sendTrailers(Object.keys(ending).length ? ending : { 'grpc-status': String(GRPC.unavailable), 'grpc-message': grpcMessage('Temporal ended the call without saying how') }));
      stream.end(sealed);
    } catch (err) {
      refuse(stream, GRPC.unavailable, `the machine gateway could not reach Temporal: ${(err as Error).message}`);
    }
  }
}
