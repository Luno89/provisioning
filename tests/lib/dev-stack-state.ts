import { temporaryStatus } from '@koala/engine-core/failures';
import { koalaReadinessOf, MY_KOALA_PATH, type KoalaReadiness } from '../../apps/backend/src/instances/lib/koala-readiness.js';
import { sessionFrom } from '../../apps/backend/src/platform/testing/handoff.js';

export type DevStackState =
  | { kind: 'ready' }
  | { kind: 'provisioning'; stage: string }
  | { kind: 'failed'; stage: string }
  | { kind: 'not this checkout'; why: string };

export interface DevStackLooks {
  rootApi: string;
  rootFrom: () => string | undefined;
  koalaFrom: () => string;
  ownerSignIn: () => { email: string; password: string } | undefined;
}

export const DEV_UP_STEP = 'Dev runs as production does';

const answered = async (url: string, init: RequestInit): Promise<{ status: number; ok: boolean; text: string; cookies: string[] } | undefined> => {
  let response: Response;
  try { response = await fetch(url, init); } catch { return undefined; }
  return { status: response.status, ok: response.ok, text: await response.text(), cookies: response.headers.getSetCookie() };
};

const refusedOrBusy = (when: string, what: string, status: number, text: string): DevStackState =>
  temporaryStatus(status)
    ? { kind: 'provisioning', stage: `root answered ${status} when ${when}: ${text.slice(0, 200)}` }
    : { kind: 'failed', stage: `root refused ${what} (${status}): ${text.slice(0, 200)}` };

export async function devStackState(repo: string, looks: DevStackLooks): Promise<DevStackState> {
  const notAnswering: DevStackState = { kind: 'provisioning', stage: `root does not answer on ${looks.rootApi} yet` };
  const signIn = looks.ownerSignIn();
  if (!signIn) return { kind: 'provisioning', stage: 'dev has not made its owner on root yet' };
  const login = await answered(`${looks.rootApi}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signIn) });
  if (!login) return notAnswering;
  if (!login.ok) return refusedOrBusy('dev\'s owner signed in', 'dev\'s owner signing in', login.status, login.text);
  const rootFrom = looks.rootFrom();
  if (!rootFrom) return { kind: 'not this checkout', why: `cannot tell which checkout root on ${looks.rootApi} runs from` };
  if (rootFrom !== repo && !rootFrom.startsWith(`${repo}/`)) return { kind: 'not this checkout', why: `root on ${looks.rootApi} runs from ${rootFrom}, not this checkout (${repo}), so it is not running this commit` };
  const cookie = sessionFrom(login.cookies);
  if (!cookie) return { kind: 'failed', stage: 'root signed dev\'s owner in without a session cookie' };
  const mine = await answered(`${looks.rootApi}${MY_KOALA_PATH}`, { headers: { Cookie: cookie } });
  if (!mine) return notAnswering;
  if (!mine.ok) return refusedOrBusy('dev\'s owner asked about their Koala', 'dev\'s owner asking about their Koala', mine.status, mine.text);
  let koala: KoalaReadiness;
  try { koala = koalaReadinessOf(JSON.parse(mine.text)); } catch (err) { return { kind: 'failed', stage: `root's answer about your Koala could not be read (${(err as Error).message}): ${mine.text.slice(0, 200)}` }; }
  if (koala.state === 'failed') return { kind: 'failed', stage: `root reports putting your Koala on this computer failed: ${koala.detail}` };
  if (koala.state === 'not yet') return { kind: 'provisioning', stage: `root has your Koala ${koala.line}` };
  let koalaFrom: string;
  try { koalaFrom = looks.koalaFrom(); } catch (err) { return { kind: 'not this checkout', why: `root reports your Koala ready, and its pods cannot be asked which checkout they run: ${(err as Error).message}` }; }
  if (koalaFrom !== repo) return { kind: 'not this checkout', why: `your Koala's pods run ${koalaFrom || 'no checkout'}, not this checkout (${repo}), so they are not running this commit` };
  return { kind: 'ready' };
}

export function devStackProblemOf(state: DevStackState): string | undefined {
  if (state.kind === 'ready') return undefined;
  if (state.kind === 'provisioning') return `the dev stack is not up yet (${state.stage}); start it with \`npm run dev\` from this checkout and let it finish`;
  if (state.kind === 'failed') return `provisioning the dev stack failed: ${state.stage}`;
  return state.why;
}

export interface ProvisioningAt { devStep?: string | undefined; root?: DevStackState | undefined }

export function provisioningFailed(why: string, at: ProvisioningAt): string {
  const where = at.devStep ? `at npm run dev's step "${at.devStep}"` : 'before npm run dev started';
  const root = at.root?.kind === 'provisioning' ? `; ${at.root.stage}` : '';
  return `provisioning the dev stack failed ${where}: ${why}${root}`;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export function devStepOf(log: string): string | undefined {
  const steps = log.replace(ANSI, '').split(/[\r\n]/).filter((line) => /^\[\d+\] /.test(line));
  return steps.at(-1);
}
