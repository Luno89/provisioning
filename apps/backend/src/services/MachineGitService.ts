import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { pushCommands } from '../lib/git-pack.js';
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

async function read(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
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

    let body: Buffer | undefined;
    if (ask.route !== 'info/refs') {
      body = ask.body ? await read(ask.body) : Buffer.alloc(0);
      if (ask.contentEncoding === 'gzip') body = gunzipSync(body);
      if (ask.route === 'git-receive-pack') {
        const commands = pushCommands(body);
        if (!commands.ok) return { status: 400, text: commands.why };
        const refused = commands.updates.find((update) => !mayPushRef(device.id, update.ref));
        if (refused) return { status: 403, text: `a machine may push only its own work branches, not ${refused.ref}` };
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
      ...(body ? { body } : {}),
    });
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
