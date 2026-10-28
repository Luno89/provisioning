export interface SignUpAccount {
  email: string;
  password: string;
  inviteCode: string;
}

export interface SignedUp {
  status: number;
  error?: string;
  cookies: string[];
  user?: { id: string; email: string };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const errorOf = (body: unknown): string | undefined =>
  body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : undefined;

async function asJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

export async function codeFromMailpit(mailpitApi: string, email: string, after: number): Promise<string> {
  for (;;) {
    const listed = await (await fetch(`${mailpitApi}/api/v1/messages`)).json() as { messages: Array<{ ID: string; Created: string; Subject: string; To: Array<{ Address: string }> }> };
    const sent = listed.messages.find((message) => message.Subject === 'Your Koala sign-up code'
      && Date.parse(message.Created) >= after - 1000
      && message.To.some((to) => to.Address.toLowerCase() === email.toLowerCase()));
    if (sent) {
      const message = await (await fetch(`${mailpitApi}/api/v1/message/${sent.ID}`)).json() as { Text: string };
      const code = /\b(\d{6})\b/.exec(message.Text)?.[1];
      if (code) return code;
    }
    await sleep(500);
  }
}

export async function signUp(apiBase: string, account: SignUpAccount, options: { mailpitApi?: string; headers?: Record<string, string> } = {}): Promise<SignedUp> {
  const post = (path: string, body: unknown) => fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: JSON.stringify(body),
  });
  const asked = Date.now();
  const registered = await post('/auth/register', account);
  const pending = await asJson(registered) as { verify?: string; devCode?: string };
  if (registered.status !== 200) return { status: registered.status, ...(errorOf(pending) ? { error: errorOf(pending)! } : {}), cookies: [] };
  if (!pending.verify) return { status: registered.status, cookies: registered.headers.getSetCookie().map((line) => line.split(';')[0]!) };
  let code = pending.devCode;
  if (!code) {
    if (!options.mailpitApi) throw new Error(`${account.email}'s sign-up code was emailed, and this suite reads no mailbox`);
    code = await codeFromMailpit(options.mailpitApi, account.email, asked);
  }
  const verified = await post('/auth/register/verify', { id: pending.verify, code });
  const body = await asJson(verified) as { user?: { id: string; email: string } };
  return {
    status: verified.status,
    ...(errorOf(body) ? { error: errorOf(body)! } : {}),
    cookies: verified.headers.getSetCookie().map((line) => line.split(';')[0]!),
    ...(body.user ? { user: body.user } : {}),
  };
}

export const sessionCookieOf = (signedUp: SignedUp): string | undefined =>
  signedUp.cookies.find((pair) => /^(__Host-)?session=/.test(pair));
