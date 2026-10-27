import crypto from 'node:crypto';
import http2 from 'node:http2';
import { frame, gatewayCallOf, gatewayDecision, handedWorkflowOf, sealedPollAnswer, unframe } from '../lib/temporal-gateway.js';

export interface MachineTemporalGatewayDeps {
  upstream: string;
  upstreamKey: () => string;
  namespace: string;
  keys: () => readonly string[];
  deviceOf: (token: string) => Promise<{ id: string } | undefined>;
  handed: (workflowId: string, deviceId: string) => Promise<void>;
  log?: ((line: string) => void) | undefined;
}

const GRPC = { ok: 0, permissionDenied: 7, unimplemented: 12, unavailable: 14, unauthenticated: 16 } as const;
const STATUS_FIELDS = new Set(['grpc-status', 'grpc-message', 'grpc-status-details-bin']);
const FORWARDED = ['content-type', 'te', 'grpc-timeout', 'grpc-accept-encoding', 'user-agent', 'client-name', 'client-version', 'supported-server-versions'];
const DEVICE_SEEN_MS = 60_000;

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
  private server: http2.Http2Server | undefined;
  private session: http2.ClientHttp2Session | undefined;
  private readonly seen = new Map<string, { deviceId: string; until: number }>();
  private readonly sessions = new Set<http2.ServerHttp2Session>();

  constructor(private readonly deps: MachineTemporalGatewayDeps) {}

  listen(port: number, host: string): Promise<number> {
    const server = http2.createServer();
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
      const session = http2.connect(`http://${this.deps.upstream}`);
      session.on('error', (err) => this.deps.log?.(`[machine-gateway] Temporal connection: ${err.message}`));
      this.session = session;
    }
    return this.session;
  }

  private async deviceFor(token: string): Promise<string | undefined> {
    const key = crypto.createHash('sha256').update(token).digest('hex');
    const known = this.seen.get(key);
    if (known && known.until > Date.now()) return known.deviceId;
    const device = await this.deps.deviceOf(token);
    if (!device) return undefined;
    this.seen.set(key, { deviceId: device.id, until: Date.now() + DEVICE_SEEN_MS });
    return device.id;
  }

  private async handle(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders): Promise<void> {
    try {
      const path = header(headers[':path']) ?? '';
      const call = gatewayCallOf(path);
      if (!call) return refuse(stream, GRPC.unimplemented, 'a machine asks Temporal only for its own work');
      const token = (header(headers.authorization) ?? '').replace(/^Bearer\s+/i, '');
      const deviceId = token ? await this.deviceFor(token) : undefined;
      if (!deviceId) return refuse(stream, GRPC.unauthenticated, 'this machine is not known here; add it again from My Machines');
      const keys = this.deps.keys();
      const decision = gatewayDecision(call, unframe(await collect(stream), header(headers['grpc-encoding'])), { deviceId, namespace: this.deps.namespace, keys });
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
        up.on('response', (h) => { answered = h; });
        up.on('trailers', (t) => { ended = t; });
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
