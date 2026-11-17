import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Provider from 'oidc-provider';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';

export interface StandInPerson {
  sub: string;
  email: string;
  email_verified: boolean;
}

export type Mischief = 'none' | 'signature' | 'audience' | 'nonce' | 'issuer';

export interface StandInIssuer {
  issuer: string;
  clientId: string;
  clientSecret: string;
  signInAs(person: StandInPerson): void;
  mischief(kind: Mischief): void;
  authorize(authorizationUrl: string): Promise<URL>;
  asked: () => URLSearchParams[];
  close(): Promise<void>;
}

type Jar = Map<string, string>;

const keep = (jar: Jar, setCookies: readonly string[]): void => {
  for (const line of setCookies) {
    const pair = line.split(';')[0]!;
    const at = pair.indexOf('=');
    const value = pair.slice(at + 1);
    if (!value || /expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(pair.slice(0, at));
    else jar.set(pair.slice(0, at), value);
  }
};

const INTERACTION = '/interaction/';

export async function startStandInIssuer(options: { redirectUris: string[]; clientId?: string; clientSecret?: string; host?: string }): Promise<StandInIssuer> {
  const clientId = options.clientId ?? 'koala-sign-in';
  const clientSecret = options.clientSecret ?? `secret-${Math.random().toString(36).slice(2)}`;
  const host = options.host ?? '127.0.0.1';
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), kid: 'stand-in', alg: 'RS256', use: 'sig' };
  let person: StandInPerson | undefined;
  let trick: Mischief = 'none';
  const asked: URLSearchParams[] = [];

  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const issuer = `http://${host}:${(server.address() as AddressInfo).port}`;

  const provider = new Provider(issuer, {
    clients: [{ client_id: clientId, client_secret: clientSecret, redirect_uris: options.redirectUris, grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_post' }],
    jwks: { keys: [jwk] as never },
    pkce: { required: () => true },
    claims: { openid: ['sub'], email: ['email', 'email_verified'], profile: ['name'] },
    conformIdTokenClaims: false,
    features: { devInteractions: { enabled: false }, userinfo: { enabled: false }, rpInitiatedLogout: { enabled: false } },
    interactions: { url: (_ctx, interaction) => `${INTERACTION}${interaction.uid}` },
    findAccount: async (_ctx, sub) => (person && person.sub === sub ? { accountId: sub, claims: async () => ({ ...person!, name: person!.email }) } : undefined),
    cookies: { keys: ['stand-in-cookie-key'] },
  });
  const callback = provider.callback();

  const forged = async (idToken: string): Promise<string> => {
    if (trick === 'signature') {
      const [head, body, signature] = idToken.split('.');
      const flipped = `${signature!.slice(0, -4)}${signature!.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
      return `${head}.${body}.${flipped}`;
    }
    const claims = { ...decodeJwt(idToken) };
    if (trick === 'audience') claims.aud = 'someone-else';
    if (trick === 'nonce') claims.nonce = 'a-nonce-nobody-sent';
    if (trick === 'issuer') claims.iss = 'https://pretender.example.com';
    return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'stand-in', typ: 'JWT' }).sign(privateKey);
  };

  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', issuer);
    if (url.pathname === '/auth' && req.method === 'GET') asked.push(url.searchParams);
    if (url.pathname.startsWith(INTERACTION)) {
      void (async () => {
        try {
          const details = await provider.interactionDetails(req, res);
          if (!person) {
            await provider.interactionFinished(req, res, { error: 'access_denied', error_description: 'nobody is signing in' }, { mergeWithLastSubmission: false });
            return;
          }
          if (details.prompt.name === 'login') {
            await provider.interactionFinished(req, res, { login: { accountId: person.sub } }, { mergeWithLastSubmission: false });
            return;
          }
          const grant = new provider.Grant({ clientId, accountId: person.sub });
          grant.addOIDCScope(String(details.params.scope ?? 'openid'));
          grant.addOIDCClaims(['email', 'email_verified', 'name']);
          await provider.interactionFinished(req, res, { consent: { grantId: await grant.save() } }, { mergeWithLastSubmission: true });
        } catch (err) {
          res.statusCode = 500;
          res.end(String((err as Error).message));
        }
      })();
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST' && trick !== 'none') {
      const chunks: Buffer[] = [];
      const write = res.write.bind(res);
      const end = res.end.bind(res);
      res.write = ((chunk: unknown) => { chunks.push(Buffer.from(chunk as Buffer)); return true; }) as typeof res.write;
      res.end = ((chunk?: unknown) => {
        if (chunk && typeof chunk !== 'function') chunks.push(Buffer.from(chunk as Buffer));
        void (async () => {
          let body = Buffer.concat(chunks).toString('utf8');
          const answer = (() => { try { return JSON.parse(body) as { id_token?: string }; } catch { return undefined; } })();
          if (answer?.id_token) body = JSON.stringify({ ...answer, id_token: await forged(answer.id_token) });
          res.setHeader('content-length', Buffer.byteLength(body));
          res.write = write;
          end(body);
        })();
        return res;
      }) as typeof res.end;
    }
    void callback(req, res);
  });

  const authorize = async (authorizationUrl: string): Promise<URL> => {
    const jar: Jar = new Map();
    let next = new URL(authorizationUrl);
    if (next.origin !== issuer) throw new Error(`the sign-in was sent to ${next.origin}, not the stand-in ${issuer}`);
    for (let hops = 0; hops < 10; hops += 1) {
      const answer = await fetch(next, { redirect: 'manual', headers: jar.size ? { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') } : {} });
      keep(jar, answer.headers.getSetCookie());
      const location = answer.headers.get('location');
      if (!location) throw new Error(`the stand-in issuer stopped at ${next.pathname}: ${answer.status} ${(await answer.text()).slice(0, 300)}`);
      next = new URL(location, next);
      if (next.origin !== issuer) return next;
    }
    throw new Error('the stand-in issuer went round without sending the person back');
  };

  return {
    issuer,
    clientId,
    clientSecret,
    signInAs: (who) => { person = who; },
    mischief: (kind) => { trick = kind; },
    authorize,
    asked: () => [...asked],
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
