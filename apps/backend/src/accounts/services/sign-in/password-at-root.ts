export type CookieJar = Map<string, string>;

export interface SignedInAtRoot {
  jar: CookieJar;
  cookie: string;
}

const SESSION_COOKIE = /^(__Host-)?koala_sid$/;

const keep = (jar: CookieJar, answer: Response): void => {
  for (const line of answer.headers.getSetCookie()) {
    const pair = line.split(';')[0]!;
    const at = pair.indexOf('=');
    const name = pair.slice(0, at);
    const value = pair.slice(at + 1);
    if (!value || /expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
};

const sent = (jar: CookieJar): string => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

const pathOf = (location: string, at: string): string => {
  const url = new URL(location, at);
  return `${url.pathname}${url.search}`;
};

const redirected = (answer: Response): boolean => answer.status >= 300 && answer.status < 400 && Boolean(answer.headers.get('location'));

export async function signInWithPassword(at: string, credentials: { email: string; password: string }, send: typeof fetch = fetch, jar: CookieJar = new Map()): Promise<SignedInAtRoot> {
  const hop = async (path: string, body?: unknown): Promise<Response> => {
    const answer = await send(new URL(path, at), {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'manual',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(jar.size ? { cookie: sent(jar) } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    keep(jar, answer);
    return answer;
  };
  const follow = async (first: Response, until: (location: URL) => boolean): Promise<URL> => {
    let answer = first;
    for (;;) {
      if (!redirected(answer)) throw new Error(`root stopped the sign-in at ${new URL(answer.url || at).pathname}: ${answer.status} ${(await answer.text()).slice(0, 300)}`);
      const location = new URL(answer.headers.get('location')!, at);
      if (until(location)) return location;
      answer = await hop(pathOf(location.href, at));
    }
  };

  const resumeAt = await follow(await hop('/api/auth/oidc/start'), (location) => location.searchParams.has('resume'));
  const resume = resumeAt.searchParams.get('resume')!;
  const login = await hop(`${resume}/login`, credentials);
  const said = await login.json() as { next?: string; twoFactorRequired?: boolean; error?: string };
  if (login.status !== 200 || !said.next) throw new Error(`signing ${credentials.email} in at root answered ${login.status}: ${said.error ?? (said.twoFactorRequired ? 'it asks for its second factor' : 'no way on')}`);
  await follow(await hop(pathOf(said.next, at)), (location) => location.hash.startsWith('#'));
  const session = [...jar].find(([name]) => SESSION_COOKIE.test(name));
  if (!session) throw new Error(`signing ${credentials.email} in at root set no session cookie`);
  return { jar, cookie: `${session[0]}=${session[1]}` };
}
