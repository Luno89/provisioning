import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { pushCommands, type PushCommands } from '../lib/git-pack.js';
import { mayPushRef } from '../lib/machine-branches.js';

export const GIT_ROUTES = ['info/refs', 'git-upload-pack', 'git-receive-pack'] as const;
export type GitRoute = (typeof GIT_ROUTES)[number];

export interface GitAsk {
  token: string | undefined;
  repo: string;
  route: GitRoute;
  service: string | undefined;
  contentType: string | undefined;
  contentEncoding: string | undefined;
  gitProtocol: string | undefined;
  body: Readable | undefined;
}

export type GitAnswer =
  | { status: number; text: string }
  | { status: number; headers: Record<string, string>; body: Readable };

export interface MachineGitDeps {
  deviceFor(token: string): Promise<{ id: string; ownerId: string } | undefined>;
  remote(ownerId: string, repo: string): Promise<{ url: string; authorization: string } | undefined>;
  fetchImpl?: typeof fetch | undefined;
}

const SERVICES = new Set(['git-upload-pack', 'git-receive-pack']);
const PASSED = ['content-type', 'cache-control', 'expires', 'pragma'];

export const PUSH_COMMANDS_AT_MOST = 1024 * 1024;

const bytes = (chunk: unknown): Buffer => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));

async function* rest(head: Buffer, iterator: AsyncIterator<unknown>): AsyncGenerator<Buffer> {
  if (head.length) yield head;
  for (let next = await iterator.next(); !next.done; next = await iterator.next()) yield bytes(next.value);
}

async function pushOf(body: Readable): Promise<{ commands: PushCommands; forward: AsyncGenerator<Buffer> }> {
  const iterator = body[Symbol.asyncIterator]();
  let head = Buffer.alloc(0);
  for (;;) {
    const commands = pushCommands(head);
    if (commands.ok || !commands.incomplete) return { commands, forward: rest(head, iterator) };
    if (head.length > PUSH_COMMANDS_AT_MOST) return { commands: { ok: false, why: 'the push\'s commands run longer than any push git sends' }, forward: rest(Buffer.alloc(0), iterator) };
    const next = await iterator.next();
    if (next.done) return { commands, forward: rest(head, iterator) };
    head = Buffer.concat([head, bytes(next.value)]);
  }
}

export class MachineGitService {
  constructor(private readonly deps: MachineGitDeps) {}

  async serve(ask: GitAsk): Promise<GitAnswer> {
    if (!ask.token) return { status: 401, text: 'this machine did not say who it is' };
    const device = await this.deps.deviceFor(ask.token);
    if (!device) return { status: 401, text: 'this machine is not one Koala knows' };
    const service = ask.route === 'info/refs' ? ask.service : ask.route;
    if (!service || !SERVICES.has(service)) return { status: 400, text: 'only fetching and pushing are served here' };
    const remote = await this.deps.remote(device.ownerId, ask.repo);
    if (!remote) return { status: 404, text: `there is no repository ${ask.repo} of yours` };

    let body: AsyncIterable<Buffer> | undefined;
    if (ask.route !== 'info/refs') {
      const raw = ask.body ?? Readable.from([]);
      const plain = ask.contentEncoding === 'gzip' ? raw.pipe(createGunzip()) : raw;
      if (ask.route === 'git-receive-pack') {
        const push = await pushOf(plain);
        if (!push.commands.ok) return { status: 400, text: push.commands.why };
        const refused = push.commands.updates.find((update) => !mayPushRef(device.id, update.ref));
        if (refused) return { status: 403, text: `a machine may push only its own work branches, not ${refused.ref}` };
        body = push.forward;
      } else {
        body = rest(Buffer.alloc(0), plain[Symbol.asyncIterator]());
      }
    }

    const target = ask.route === 'info/refs' ? `${remote.url}/info/refs?service=${service}` : `${remote.url}/${ask.route}`;
    const answered = await (this.deps.fetchImpl ?? fetch)(target, {
      method: ask.route === 'info/refs' ? 'GET' : 'POST',
      headers: {
        Authorization: remote.authorization,
        ...(ask.contentType ? { 'Content-Type': ask.contentType } : {}),
        ...(ask.gitProtocol ? { 'Git-Protocol': ask.gitProtocol } : {}),
      },
      ...(body ? { body: Readable.toWeb(Readable.from(body)) as unknown as ReadableStream, duplex: 'half' } : {}),
    } as RequestInit);
    const headers: Record<string, string> = {};
    for (const name of PASSED) {
      const value = answered.headers.get(name);
      if (value) headers[name] = value;
    }
    return {
      status: answered.status,
      headers,
      body: answered.body ? Readable.fromWeb(answered.body as never) : Readable.from([]),
    };
  }
}
