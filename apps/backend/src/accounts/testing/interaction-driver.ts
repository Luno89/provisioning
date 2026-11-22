import { START_PATH } from '../../instances/lib/oidc.js';
import type { CookieJar, SignedInAtRoot } from '../services/sign-in/password-at-root.js';

export interface Interaction {
  jar: CookieJar;
  path: string;
  ask(path: string, body?: unknown): Promise<Response>;
  onward(first: Response, until: (location: URL) => boolean): Promise<URL>;
  login(body: unknown): Promise<Response>;
  secondFactor(code: unknown): Promise<Response>;
  signUp(id: unknown, code: unknown): Promise<Response>;
  followed(next: string): Promise<SignedInAtRoot>;
}

const BROWSER_SESSION = /^(__Host-)?koala_sid$/;

export async function interactionAt(root: string, send: typeof fetch = fetch, jar: CookieJar = new Map()): Promise<Interaction> {
  const ask = async (path: string, body?: unknown): Promise<Response> => {
    const cookies = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const answer = await send(new URL(path, root), {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'manual',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookies ? { cookie: cookies } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const line of answer.headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const split = pair.indexOf('=');
      const value = pair.slice(split + 1);
      if (!value || /expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(pair.slice(0, split));
      else jar.set(pair.slice(0, split), value);
    }
    return answer;
  };
  const onward = async (first: Response, until: (location: URL) => boolean): Promise<URL> => {
    for (let answer = first; ;) {
      const location = answer.headers.get('location');
      if (answer.status < 300 || answer.status >= 400 || !location) throw new Error(`the sign-in stopped at ${new URL(answer.url || root).pathname} with ${answer.status}: ${(await answer.text()).slice(0, 600)}`);
      const url = new URL(location, root);
      if (until(url)) return url;
      answer = await ask(`${url.pathname}${url.search}`);
    }
  };
  const resumed = await onward(await ask(START_PATH), (location) => location.searchParams.has('resume'));
  const path = resumed.searchParams.get('resume')!;
  return {
    jar, path, ask, onward,
    login: (body) => ask(`${path}/login`, body),
    secondFactor: (code) => ask(`${path}/second-factor`, { code }),
    signUp: (id, code) => ask(`${path}/sign-up/verify`, { id, code }),
    followed: async (next) => {
      const url = new URL(next, root);
      await onward(await ask(`${url.pathname}${url.search}`), (location) => location.hash.startsWith('#'));
      const session = [...jar].find(([name]) => BROWSER_SESSION.test(name));
      if (!session) throw new Error('the sign-in set no session cookie');
      return { jar, cookie: `${session[0]}=${session[1]}` };
    },
  };
}
