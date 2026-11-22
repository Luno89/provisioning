export interface Browsing {
  hop(path: string, body?: unknown): Promise<Response>;
  followed(path: string, until: (at: URL) => boolean): Promise<URL>;
  resume(): Promise<string>;
  cookies(): string[];
}

export function browsing(site: string, options: { send?: typeof fetch; headers?: Record<string, string> } = {}): Browsing {
  const send = options.send ?? fetch;
  const jar = new Map<string, string>();
  const cookies = (): string[] => [...jar].map(([name, value]) => `${name}=${value}`);
  const hop = async (path: string, body?: unknown): Promise<Response> => {
    const cookie = cookies().join('; ');
    const answer = await send(new URL(path, site), {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'manual',
      headers: { ...(options.headers ?? {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const line of answer.headers.getSetCookie()) {
      const [name = '', value = ''] = line.split(';')[0]!.split(/=(.*)/s);
      if (value && !/expires=Thu, 01 Jan 1970/i.test(line)) jar.set(name, value);
      else jar.delete(name);
    }
    return answer;
  };
  const followed = async (path: string, until: (at: URL) => boolean): Promise<URL> => {
    let at = new URL(path, site);
    for (;;) {
      const answer = await hop(`${at.pathname}${at.search}`);
      const location = answer.headers.get('location');
      if (answer.status < 300 || answer.status >= 400 || !location) throw new Error(`${site} stopped the sign-in at ${at.pathname}: ${answer.status} ${(await answer.text()).slice(0, 300)}`);
      at = new URL(location, at);
      if (until(at)) return at;
    }
  };
  const resume = async (): Promise<string> => {
    const resumed = (await followed('/api/auth/oidc/start', (at) => at.searchParams.has('resume'))).searchParams.get('resume');
    if (!resumed) throw new Error(`${site} sent the sign-in back with no sign-in to resume`);
    return resumed;
  };
  return { hop, followed, resume, cookies };
}
