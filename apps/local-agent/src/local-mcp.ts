import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MAX_BODY_BYTES = 1_000_000;
export const PROGRESS_EVERY_MS = 20_000;

export interface LocalTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string>;
}

export interface Mounted {
  url: string;
  unmount(): void;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const reply = (id: RpcMessage['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const failure = (id: RpcMessage['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

const readBody = (request: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  let size = 0;
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      reject(new Error('request too large'));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  request.on('error', reject);
});

export interface LocalMcpOptions {
  progressEveryMs?: number | undefined;
  log?: ((line: string) => void) | undefined;
}

export class LocalMcpServer {
  constructor(private readonly options: LocalMcpOptions = {}) {}

  private server: Server | undefined;
  private port = 0;
  private readonly mounts = new Map<string, { tools: LocalTool[]; instructions: string }>();

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.mounts.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  mount(tools: LocalTool[], instructions: string): Mounted {
    if (!this.server) throw new Error('the local MCP server is not started');
    const path = `/mcp/${randomBytes(18).toString('hex')}`;
    this.mounts.set(path, { tools, instructions });
    return { url: `http://127.0.0.1:${this.port}${path}`, unmount: () => { this.mounts.delete(path); } };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const mounted = this.mounts.get((request.url ?? '').split('?')[0] ?? '');
    if (!mounted) return this.send(response, 404, { error: 'no such server' });
    if (request.method === 'DELETE') return this.send(response, 200, {});
    if (request.method !== 'POST') return this.send(response, 405, { error: 'POST only' });

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(request));
    } catch (err) {
      return this.send(response, 400, failure(null, -32700, (err as Error).message));
    }
    const single = !Array.isArray(parsed) ? parsed as RpcMessage : undefined;
    if (single?.method === 'tools/call' && single.id !== undefined && String(request.headers.accept ?? '').includes('text/event-stream')) {
      return this.stream(single, mounted, response);
    }
    const messages = (Array.isArray(parsed) ? parsed : [parsed]) as RpcMessage[];
    const answers = (await Promise.all(messages.map((message) => this.answer(message, mounted)))).filter((answer) => answer !== undefined);
    if (answers.length === 0) {
      response.writeHead(202).end();
      return;
    }
    this.send(response, 200, Array.isArray(parsed) ? answers : answers[0]);
  }

  private async answer(message: RpcMessage, mounted: { tools: LocalTool[]; instructions: string }): Promise<unknown> {
    if (message.id === undefined) return undefined;
    switch (message.method) {
      case 'initialize':
        return reply(message.id, {
          protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'koala', version: '1' },
          instructions: mounted.instructions,
        });
      case 'ping':
        return reply(message.id, {});
      case 'tools/list':
        return reply(message.id, { tools: mounted.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const name = message.params?.name;
        const tool = mounted.tools.find((candidate) => candidate.name === name);
        if (!tool) return failure(message.id, -32602, `there is no tool called ${String(name)}`);
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          return reply(message.id, { content: [{ type: 'text', text: await tool.run(args) }] });
        } catch (err) {
          return reply(message.id, { content: [{ type: 'text', text: (err as Error).message }], isError: true });
        }
      }
      default:
        return failure(message.id, -32601, `${message.method ?? 'that'} is not something this server does`);
    }
  }

  private async stream(message: RpcMessage, mounted: { tools: LocalTool[]; instructions: string }, response: ServerResponse): Promise<void> {
    const meta = message.params?._meta as { progressToken?: unknown } | undefined;
    const token = typeof meta?.progressToken === 'string' || typeof meta?.progressToken === 'number' ? meta.progressToken : undefined;
    this.options.log?.(`${String(message.params?.name)} was called ${token === undefined ? 'without a progress token' : 'with a progress token'}`);
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const event = (body: unknown) => { response.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`); };
    let progress = 0;
    const beating = setInterval(() => {
      progress += 1;
      if (token === undefined) response.write(': still working\n\n');
      else event({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress, message: 'still working' } });
    }, this.options.progressEveryMs ?? PROGRESS_EVERY_MS);
    response.on('close', () => clearInterval(beating));
    try {
      event(await this.answer(message, mounted));
    } finally {
      clearInterval(beating);
      response.end();
    }
  }

  private send(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  }
}
