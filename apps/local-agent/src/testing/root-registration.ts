import { METRICS_CLIENT_FIELDS, metricsClientIdOf, OIDC_PATH } from '@koala/engine-core/root-client';

export interface Registered {
  clientId: string;
  code: string;
  keys: Array<{ kid?: string; x?: string }>;
}

export interface RootRegistration {
  registered: Registered[];
  codeFor(clientId: string): string;
  answer(request: Request): Promise<Response | undefined>;
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function rootRegistration(): RootRegistration {
  const codes = new Map<string, string>();
  const registered: Registered[] = [];
  let made = 0;
  return {
    registered,
    codeFor: (clientId) => {
      made += 1;
      const code = `registration-code-${made}`;
      for (const [held, client] of codes) if (client === clientId) codes.delete(held);
      codes.set(code, clientId);
      return code;
    },
    answer: async (request) => {
      const url = new URL(request.url);
      const issuer = `${url.origin}${OIDC_PATH}`;
      if (url.pathname === `${OIDC_PATH}/.well-known/openid-configuration`) {
        return json(200, { issuer, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/reg`, jwks_uri: `${issuer}/jwks`, token_endpoint_auth_methods_supported: ['private_key_jwt'] });
      }
      if (url.pathname === `${OIDC_PATH}/token` && request.method === 'POST') {
        const form = new URLSearchParams(await request.text());
        const assertion = form.get('client_assertion') ?? '';
        const header = JSON.parse(Buffer.from(assertion.split('.')[0] ?? '', 'base64url').toString() || '{}') as { kid?: string };
        const clientId = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString() || '{}') as { sub?: string };
        const known = registered.findLast((client) => client.clientId === clientId.sub);
        if (!known?.keys.some((key) => key.kid === header.kid)) return json(401, { error: 'invalid_client', error_description: 'client authentication failed' });
        const resource = form.get('resource');
        return json(200, { access_token: `token-for-${known.clientId}${resource ? `-at-${resource}` : ''}`, token_type: 'Bearer', expires_in: 300, scope: form.get('scope') ?? '' });
      }
      if (url.pathname === `${OIDC_PATH}/reg` && request.method === 'POST') {
        const code = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
        const clientId = codes.get(code);
        if (!clientId) return json(401, { error: 'invalid_token', error_description: 'this registration code was used already, or a newer one replaced it' });
        codes.delete(code);
        const metadata = await request.json() as { jwks?: { keys?: Registered['keys'] } };
        registered.push({ clientId, code, keys: metadata.jwks?.keys ?? [] });
        return json(201, { ...metadata, client_id: clientId, [METRICS_CLIENT_FIELDS.id]: metricsClientIdOf(clientId), [METRICS_CLIENT_FIELDS.secret]: `metrics-secret-of-${clientId}` });
      }
      return undefined;
    },
  };
}
