import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { ignore } from '@koala/engine-core/failures';

const run = promisify(execFile);
const ADMIN = 'provisioning-bot';
const HEADER_END = Buffer.from('\r\n\r\n');

interface Account { login: string; password: string; email: string; admin: boolean; org: boolean; visibility: string; tokens: Map<string, string> }
interface Hook { id: number; url: string; secret: string }
interface Repo { owner: string; name: string; hooks: Hook[]; writers: Set<string> }

export interface Delivery { url: string; ref: string; status: number | string }

export interface GiteaStandIn {
  url: string;
  adminPassword: string;
  unhandled: string[];
  deliveries: Delivery[];
  close(): Promise<void>;
}

type Answer = { status: number; body?: unknown; text?: string };

const keyOf = (owner: string, name: string): string => `${owner.toLowerCase()}/${name.toLowerCase()}`;

async function git(bare: string, args: readonly string[], options: { input?: Buffer | string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn('git', ['--git-dir', bare, ...args], { env: { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Gitea', GIT_AUTHOR_EMAIL: 'gitea@stand-in.test', GIT_COMMITTER_NAME: 'Gitea', GIT_COMMITTER_EMAIL: 'gitea@stand-in.test', ...options.env }, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done(Buffer.concat(out).toString('utf8')) : fail(new Error(`git ${args[0]} exited ${code}: ${Buffer.concat(err).toString('utf8')}`))));
    if (options.input !== undefined) {
      child.stdin!.on('error', ignore('git closed its input early; its exit code says whether it failed'));
      child.stdin!.end(options.input);
    }
  });
}

async function gitBytes(bare: string, args: readonly string[]): Promise<Buffer> {
  const { stdout } = await run('git', ['--git-dir', bare, ...args], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

export async function startGiteaStandIn(): Promise<GiteaStandIn> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'koala-gitea-'));
  const adminPassword = crypto.randomBytes(18).toString('base64url');
  const accounts = new Map<string, Account>();
  const repos = new Map<string, Repo>();
  const unhandled: string[] = [];
  const deliveries: Delivery[] = [];
  let hookIds = 0;
  let baseUrl = '';
  accounts.set(ADMIN, { login: ADMIN, password: adminPassword, email: 'bot@stand-in.test', admin: true, org: false, visibility: 'public', tokens: new Map() });

  const bareOf = (repo: Pick<Repo, 'owner' | 'name'>): string => path.join(root, repo.owner.toLowerCase(), `${repo.name.toLowerCase()}.git`);

  const whoIs = (header: string | undefined): Account | undefined => {
    if (!header) return undefined;
    const [scheme, value = ''] = header.split(' ');
    if (scheme?.toLowerCase() === 'token') return [...accounts.values()].find((account) => [...account.tokens.values()].includes(value));
    if (scheme?.toLowerCase() !== 'basic') return undefined;
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const at = decoded.indexOf(':');
    const account = accounts.get(decoded.slice(0, at).toLowerCase());
    const secret = decoded.slice(at + 1);
    return account && !account.org && (account.password === secret || [...account.tokens.values()].includes(secret)) ? account : undefined;
  };

  const reaches = (who: Account, repo: Repo): boolean => who.admin || who.login === repo.owner.toLowerCase() || repo.writers.has(who.login);

  const heads = async (repo: Repo): Promise<Map<string, string>> => {
    const listed = await git(bareOf(repo), ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    return new Map(listed.split('\n').filter(Boolean).map((line) => line.split(' ') as [string, string]));
  };

  const commitsBetween = async (repo: Repo, before: string | undefined, after: string) => {
    const range = before ? [`${before}..${after}`] : [after];
    const ids = (await git(bareOf(repo), ['rev-list', '--reverse', ...range])).split('\n').filter(Boolean);
    return Promise.all(ids.map(async (id) => {
      const changes = (await git(bareOf(repo), ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', id])).split('\n').filter(Boolean).map((line) => line.split('\t') as [string, string]);
      const message = await git(bareOf(repo), ['log', '-1', '--format=%B', id]);
      return {
        id, message,
        added: changes.filter(([kind]) => kind === 'A').map(([, file]) => file),
        modified: changes.filter(([kind]) => kind === 'M').map(([, file]) => file),
        removed: changes.filter(([kind]) => kind === 'D').map(([, file]) => file),
      };
    }));
  };

  const deliver = async (repo: Repo, before: Map<string, string>, pusher: string): Promise<void> => {
    const after = await heads(repo);
    for (const [ref, sha] of after) {
      if (before.get(ref) === sha) continue;
      const payload = Buffer.from(JSON.stringify({
        ref, before: before.get(ref) ?? '0'.repeat(40), after: sha,
        commits: await commitsBetween(repo, before.get(ref), sha),
        repository: { name: repo.name, full_name: `${repo.owner}/${repo.name}`, default_branch: 'main', owner: { login: repo.owner, username: repo.owner } },
        pusher: { login: pusher, username: pusher },
      }));
      for (const hook of repo.hooks) {
        const signature = crypto.createHmac('sha256', hook.secret).update(payload).digest('hex');
        const sent = await fetch(hook.url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Gitea-Event': 'push', 'X-Gitea-Signature': signature }, body: payload })
          .then(async (answer) => { await answer.arrayBuffer(); return answer.status; }, (err: Error) => err.message);
        deliveries.push({ url: hook.url, ref, status: sent });
      }
    }
  };

  const makeRepo = async (owner: string, name: string, autoInit: boolean, by: string): Promise<Answer> => {
    const key = keyOf(owner, name);
    if (repos.has(key)) return { status: 409, body: { message: 'The repository with the same name already exists.' } };
    const repo: Repo = { owner: owner.toLowerCase(), name: name.toLowerCase(), hooks: [], writers: new Set() };
    await fs.mkdir(path.dirname(bareOf(repo)), { recursive: true });
    await run('git', ['init', '--bare', '--quiet', '--initial-branch=main', bareOf(repo)]);
    repos.set(key, repo);
    if (autoInit) await commitFiles(repo, 'main', [{ path: 'README.md', content: Buffer.from(`# ${name}\n`) }], 'Initial commit', by, false);
    return { status: 201, body: repoView(repo) };
  };

  const repoView = (repo: Repo) => ({
    name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner, username: repo.owner },
    clone_url: `${baseUrl}/${repo.owner}/${repo.name}.git`, default_branch: 'main', private: true,
  });

  const commitFiles = async (repo: Repo, branch: string, changes: { path: string; content?: Buffer | undefined }[], message: string, by: string, tell = true): Promise<string> => {
    const bare = bareOf(repo);
    const before = await heads(repo);
    const parent = before.get(`refs/heads/${branch}`);
    const index = path.join(root, `.index-${crypto.randomBytes(6).toString('hex')}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await git(bare, parent ? ['read-tree', parent] : ['read-tree', '--empty'], { env });
      for (const change of changes) {
        if (change.content === undefined) await git(bare, ['update-index', '--force-remove', change.path], { env });
        else {
          const blob = (await git(bare, ['hash-object', '-w', '--stdin'], { input: change.content })).trim();
          await git(bare, ['update-index', '--add', '--cacheinfo', `100644,${blob},${change.path}`], { env });
        }
      }
      const tree = (await git(bare, ['write-tree'], { env })).trim();
      const commit = (await git(bare, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message])).trim();
      await git(bare, ['update-ref', `refs/heads/${branch}`, commit, ...(parent ? [parent] : [])]);
      if (tell) await deliver(repo, before, by);
      return commit;
    } finally {
      await fs.rm(index, { force: true });
    }
  };

  const objectAt = async (repo: Repo, ref: string, file: string): Promise<{ sha: string; type: string } | undefined> => {
    const spec = `${ref}:${file}`;
    const sha = await git(bareOf(repo), ['rev-parse', '--verify', '--quiet', spec]).then((out) => out.trim(), ignore('a path that is not at that ref is answered 404, as Gitea does'));
    if (!sha) return undefined;
    return { sha, type: (await git(bareOf(repo), ['cat-file', '-t', sha])).trim() };
  };

  const entryOf = (file: string, type: string, sha: string, content?: Buffer) => ({
    path: file, name: path.posix.basename(file), sha, type: type === 'tree' ? 'dir' : 'file', ...(content ? { size: content.length, content: content.toString('base64'), encoding: 'base64' } : {}),
  });

  const contents = async (repo: Repo, file: string, ref: string): Promise<Answer> => {
    if (!(await heads(repo)).size) return { status: 404, body: { message: 'the repository is empty' } };
    const found = file ? await objectAt(repo, ref, file) : { sha: ref, type: 'tree' };
    if (!found) return { status: 404, body: { message: 'object does not exist' } };
    if (found.type === 'blob') return { status: 200, body: entryOf(file, 'blob', found.sha, await gitBytes(bareOf(repo), ['cat-file', 'blob', found.sha])) };
    const listed = await git(bareOf(repo), ['ls-tree', file ? `${ref}:${file}` : ref]);
    return { status: 200, body: listed.split('\n').filter(Boolean).map((line) => {
      const [meta = '', name = ''] = line.split('\t');
      const [, type = 'blob', sha = ''] = meta.split(' ');
      return entryOf(file ? `${file}/${name}` : name, type, sha);
    }) };
  };

  const api = async (method: string, route: string, query: URLSearchParams, body: Buffer, who: Account | undefined): Promise<Answer | undefined> => {
    const json = (): Record<string, unknown> => (body.length ? JSON.parse(body.toString('utf8')) as Record<string, unknown> : {});
    const parts = route.split('/').filter(Boolean).map(decodeURIComponent);
    const [first, second, third, fourth] = parts;
    if (method === 'POST' && first === 'users' && third === 'tokens' && parts.length === 3) {
      if (!who || who.login !== second?.toLowerCase()) return { status: 401, body: { message: 'unauthorized' } };
      const name = String(json().name);
      if (who.tokens.has(name)) return { status: 400, body: { message: 'access token name has been used already' } };
      const sha1 = crypto.randomBytes(20).toString('hex');
      who.tokens.set(name, sha1);
      return { status: 201, body: { name, sha1 } };
    }
    if (!who) return { status: 401, body: { message: 'token is required' } };
    if (method === 'GET' && route === '/user') return { status: 200, body: { login: who.login, is_admin: who.admin } };
    if (first === 'users' && third === 'tokens') {
      const owner = accounts.get(second?.toLowerCase() ?? '');
      if (!owner || (owner !== who && !who.admin)) return { status: 401, body: { message: 'unauthorized' } };
      if (method === 'GET' && parts.length === 3) {
        const limit = Number(query.get('limit') ?? 50);
        const page = Number(query.get('page') ?? 1);
        return { status: 200, body: [...owner.tokens.keys()].slice((page - 1) * limit, page * limit).map((name) => ({ name })) };
      }
      if (method === 'DELETE' && fourth) return owner.tokens.delete(fourth) ? { status: 204 } : { status: 404, body: { message: 'token not found' } };
    }
    if (method === 'GET' && first === 'users' && parts.length === 2) return accounts.has(second!.toLowerCase()) ? { status: 200, body: { login: second } } : { status: 404, body: { message: 'user does not exist' } };
    if (first === 'admin' && second === 'users') {
      if (!who.admin) return { status: 403, body: { message: 'must be an admin' } };
      if (method === 'GET' && parts.length === 2) {
        const limit = Number(query.get('limit') ?? 50);
        const page = Number(query.get('page') ?? 1);
        return { status: 200, body: [...accounts.values()].filter((account) => !account.org).slice((page - 1) * limit, page * limit).map((account) => ({ login: account.login, login_name: account.login, source_id: 0, visibility: account.visibility })) };
      }
      if (method === 'POST' && parts.length === 2) {
        const given = json();
        const login = String(given.username).toLowerCase();
        if (accounts.has(login)) return { status: 422, body: { message: 'user already exists' } };
        accounts.set(login, { login, password: String(given.password), email: String(given.email), admin: false, org: false, visibility: String(given.visibility ?? 'public'), tokens: new Map() });
        return { status: 201, body: { login } };
      }
      const account = accounts.get(third?.toLowerCase() ?? '');
      if (method === 'PATCH' && parts.length === 3) {
        if (!account) return { status: 404, body: { message: 'user does not exist' } };
        const given = json();
        if (typeof given.visibility === 'string') account.visibility = given.visibility;
        if (typeof given.password === 'string') account.password = given.password;
        return { status: 200, body: { login: account.login } };
      }
      if (method === 'DELETE' && parts.length === 3) {
        if (!account || account.org) return { status: 404, body: { message: 'user does not exist' } };
        for (const [key, repo] of repos) {
          if (repo.owner === account.login) { repos.delete(key); await fs.rm(bareOf(repo), { recursive: true, force: true }); }
          repo.writers.delete(account.login);
        }
        accounts.delete(account.login);
        return { status: 204 };
      }
      if (method === 'POST' && fourth === 'repos') {
        if (!account) return { status: 404, body: { message: 'user does not exist' } };
        const given = json();
        return makeRepo(account.login, String(given.name), given.auto_init === true, who.login);
      }
    }
    if (method === 'POST' && first === 'user' && second === 'repos') {
      const given = json();
      return makeRepo(who.login, String(given.name), given.auto_init === true, who.login);
    }
    if (first === 'orgs') {
      if (method === 'POST' && parts.length === 1) {
        const login = String(json().username).toLowerCase();
        if (accounts.has(login)) return { status: 422, body: { message: 'user already exists' } };
        accounts.set(login, { login, password: crypto.randomBytes(18).toString('hex'), email: '', admin: false, org: true, visibility: 'private', tokens: new Map() });
        return { status: 201, body: { username: login } };
      }
      const org = accounts.get(second?.toLowerCase() ?? '');
      if (!org?.org) return { status: 404, body: { message: 'org does not exist' } };
      if (method === 'GET' && parts.length === 2) return { status: 200, body: { username: org.login } };
      if (method === 'DELETE' && parts.length === 2) {
        if ([...repos.values()].some((repo) => repo.owner === org.login)) return { status: 422, body: { message: 'org still owns one or more repositories' } };
        accounts.delete(org.login);
        return { status: 204 };
      }
      if (method === 'POST' && third === 'repos') {
        const given = json();
        return makeRepo(org.login, String(given.name), given.auto_init === true, who.login);
      }
    }
    if (first === 'repos' && second && third) {
      const repo = repos.get(keyOf(second, third));
      if (!repo || !reaches(who, repo)) return { status: 404, body: { message: 'repository does not exist' } };
      const rest = parts.slice(3);
      const tail = route.split('/').slice(4).join('/');
      if (rest.length === 0 && method === 'GET') return { status: 200, body: { ...repoView(repo), empty: !(await heads(repo)).size } };
      if (rest.length === 0 && method === 'DELETE') {
        repos.delete(keyOf(second, third));
        await fs.rm(bareOf(repo), { recursive: true, force: true });
        return { status: 204 };
      }
      if (rest[0] === 'hooks') {
        if (method === 'GET' && rest.length === 1) return { status: 200, body: repo.hooks.map((hook) => ({ id: hook.id, type: 'gitea', active: true, events: ['push'], config: { url: hook.url, content_type: 'json' } })) };
        if (method === 'POST' && rest.length === 1) {
          const config = (json().config ?? {}) as { url?: string; secret?: string };
          hookIds += 1;
          repo.hooks.push({ id: hookIds, url: String(config.url), secret: String(config.secret ?? '') });
          return { status: 201, body: { id: hookIds } };
        }
        if (method === 'DELETE' && rest.length === 2) {
          const before = repo.hooks.length;
          repo.hooks = repo.hooks.filter((hook) => hook.id !== Number(rest[1]));
          return repo.hooks.length < before ? { status: 204 } : { status: 404, body: { message: 'hook does not exist' } };
        }
      }
      if (method === 'PUT' && rest[0] === 'collaborators' && rest[1]) {
        if (!accounts.has(rest[1].toLowerCase())) return { status: 422, body: { message: 'user does not exist' } };
        repo.writers.add(rest[1].toLowerCase());
        return { status: 204 };
      }
      if (rest[0] === 'contents') {
        const file = decodeURIComponent(tail.replace(/^contents\/?/, ''));
        if (method === 'GET') return contents(repo, file, query.get('ref') ?? 'main');
        const given = json() as { content?: string; message?: string; branch?: string; sha?: string; files?: { operation: string; path: string; content?: string; sha?: string }[] };
        const branch = given.branch ?? 'main';
        if (method === 'POST' && !file) {
          const changes = (given.files ?? []).map((change) => ({ path: change.path, content: change.operation === 'delete' ? undefined : Buffer.from(change.content ?? '', 'base64') }));
          const sha = await commitFiles(repo, branch, changes, given.message ?? 'Update files', who.login);
          return { status: 201, body: { commit: { sha } } };
        }
        const current = (await heads(repo)).has(`refs/heads/${branch}`) ? await objectAt(repo, branch, file) : undefined;
        if (method === 'POST' && current) return { status: 422, body: { message: 'repository file already exists' } };
        if (method === 'PUT' && current?.sha !== given.sha) return { status: 409, body: { message: 'sha does not match' } };
        if (method === 'DELETE') {
          if (!current) return { status: 404, body: { message: 'file does not exist' } };
          const sha = await commitFiles(repo, branch, [{ path: file }], given.message ?? `Delete ${file}`, who.login);
          return { status: 200, body: { commit: { sha } } };
        }
        if (method === 'POST' || method === 'PUT') {
          const sha = await commitFiles(repo, branch, [{ path: file, content: Buffer.from(given.content ?? '', 'base64') }], given.message ?? `Update ${file}`, who.login);
          return { status: method === 'POST' ? 201 : 200, body: { commit: { sha }, content: entryOf(file, 'blob', (await objectAt(repo, sha, file))!.sha) } };
        }
      }
      if (method === 'GET' && rest[0] === 'raw') {
        const file = decodeURIComponent(tail.replace(/^raw\//, ''));
        if (!(await heads(repo)).size) return { status: 404, text: 'Not found' };
        const found = await objectAt(repo, query.get('ref') ?? 'main', file);
        if (found?.type !== 'blob') return { status: 404, text: 'Not found' };
        return { status: 200, text: (await gitBytes(bareOf(repo), ['cat-file', 'blob', found.sha])).toString('utf8') };
      }
      if (method === 'GET' && rest[0] === 'git' && rest[1] === 'trees' && rest[2]) {
        const ref = rest.slice(2).join('/');
        const listed = await git(bareOf(repo), ['ls-tree', '-r', ref]).catch(ignore('a ref the repository does not have is answered 404, as Gitea does'));
        if (listed === undefined) return { status: 404, body: { message: 'sha not found' } };
        return { status: 200, body: { truncated: false, tree: listed.split('\n').filter(Boolean).map((line) => {
          const [meta = '', file = ''] = line.split('\t');
          const [, type = 'blob', sha = ''] = meta.split(' ');
          return { path: file, type, sha };
        }) } };
      }
      if (method === 'GET' && rest[0] === 'git' && rest[1] === 'commits' && rest[2]) {
        const shown = await git(bareOf(repo), ['log', '-1', '--format=%an%x00%aI%x00%B', rest[2]]).catch(ignore('a commit the repository does not have is answered 404, as Gitea does'));
        if (shown === undefined) return { status: 404, body: { message: 'commit not found' } };
        const [author, date, message] = shown.split('\0');
        return { status: 200, body: { sha: rest[2], commit: { message, author: { name: author, date } } } };
      }
      if (rest[0] === 'branches' && rest[1]) {
        const branch = rest.slice(1).join('/');
        const sha = (await heads(repo)).get(`refs/heads/${branch}`);
        if (!sha) return { status: 404, body: { message: 'branch does not exist' } };
        if (method === 'GET') return { status: 200, body: { name: branch, commit: { id: sha } } };
        if (method === 'DELETE') { await git(bareOf(repo), ['update-ref', '-d', `refs/heads/${branch}`, sha]); return { status: 204 }; }
      }
      if (method === 'GET' && rest[0] === 'pulls') return { status: 200, body: [] };
    }
    return undefined;
  };

  const serveGit = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, repo: Repo, who: Account): void => {
    const pushing = url.pathname.endsWith('/git-receive-pack') || url.searchParams.get('service') === 'git-receive-pack';
    const before = pushing ? heads(repo) : undefined;
    const cgi = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: req.method ?? 'GET',
        PATH_INFO: `/${repo.owner}/${repo.name}.git${url.pathname.slice(url.pathname.indexOf('.git') + 4)}`, QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: who.login, REMOTE_ADDR: '127.0.0.1',
        ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) } : {}),
        ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: String(req.headers['git-protocol']) } : {}),
      },
    });
    cgi.stdin.on('error', ignore('git closes its input once it has read what it needs; the answer it sends still goes back'));
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let sent = false;
    cgi.stdout.on('data', (chunk: Buffer) => {
      if (sent) { res.write(chunk); return; }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf(HEADER_END);
      if (end < 0) return;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.subarray(0, end).toString('utf8').split('\r\n')) {
        const [name = '', ...value] = line.split(':');
        if (name.toLowerCase() === 'status') status = Number(value.join(':').trim().split(' ')[0]);
        else headers[name] = value.join(':').trim();
      }
      res.writeHead(status, headers);
      sent = true;
      res.write(head.subarray(end + HEADER_END.length));
    });
    cgi.on('close', () => {
      if (!sent) res.writeHead(502);
      res.end();
      if (before && url.pathname.endsWith('/git-receive-pack')) {
        void before.then((was) => deliver(repo, was, who.login)).catch(ignore('a push whose webhooks could not be sent is still pushed; what was delivered is kept in deliveries'));
      }
    });
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://gitea.test');
      const who = whoIs(req.headers.authorization);
      const gitPath = /^\/([^/]+)\/([^/]+?)\.git(\/.*)$/.exec(url.pathname);
      if (gitPath) {
        const repo = repos.get(keyOf(decodeURIComponent(gitPath[1]!), decodeURIComponent(gitPath[2]!)));
        if (!who) { res.writeHead(401, { 'www-authenticate': 'Basic realm="Gitea"' }).end('Unauthorized'); return; }
        if (!repo || !reaches(who, repo)) { res.writeHead(404).end('Not found'); return; }
        serveGit(req, res, url, repo, who);
        return;
      }
      const body = await readBody(req);
      if (url.pathname === '/v2/' || url.pathname === '/v2') { res.writeHead(401).end(); return; }
      const answer = url.pathname.startsWith('/api/v1/') ? await api(req.method ?? 'GET', url.pathname.slice('/api/v1'.length), url.searchParams, body, who) : undefined;
      if (!answer) {
        unhandled.push(`${req.method} ${url.pathname}`);
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: `the Gitea stand-in has no ${req.method} ${url.pathname}` }));
        return;
      }
      if (answer.text !== undefined) res.writeHead(answer.status, { 'content-type': 'text/plain' }).end(answer.text);
      else if (answer.body === undefined) res.writeHead(answer.status).end();
      else res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
    })().catch((err: Error) => {
      unhandled.push(`${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: err.message }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: baseUrl,
    adminPassword,
    unhandled,
    deliveries,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
