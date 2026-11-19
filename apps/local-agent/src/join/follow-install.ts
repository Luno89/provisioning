import { failureOf, statusFailure } from '@koala/engine-core/failures';
import { KOALA_INSTALL_FOLLOW_BEAT_MS, KOALA_INSTALL_FOLLOW_PATH, KOALA_INSTALL_FOLLOW_STOPPED, koalaInstallFollowedOf, koalaInstallStoppedOf, type KoalaInstallFollowed } from '@koala/engine-core/koala-install';
import { Hopeless, waitUntil, type WaitOptions } from '@koala/provision';
import { rootUrlOf } from '../root-progress.js';

export type FollowEnd = 'none' | 'ready' | 'failed' | 'stopped' | 'interrupted';

export interface InstallFollow {
  rootUrl: string;
  token: string;
  fetch: typeof fetch;
  say(line: string): void;
  section(title: string): void;
  interrupted: AbortSignal;
  wait?: WaitOptions | undefined;
}

const QUIET_BEATS = 4;

const PUTTING = 'Putting Koala on this machine';
const MOVING = 'Moving your Koala to this machine';

const reasonOf = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  return err instanceof Error && err.cause instanceof Error ? `${message} (${err.cause.message})` : message;
};

class Dropped extends Error {}

interface SseEvent {
  kind: string;
  data: string;
}

function eventsOf(text: string): { events: SseEvent[]; rest: string } {
  const blocks = text.replace(/\r\n/g, '\n').split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: SseEvent[] = [];
  for (const block of blocks) {
    let kind = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':') || line === '') continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') kind = value;
      if (field === 'data') data.push(value);
    }
    if (data.length > 0) events.push({ kind, data: data.join('\n') });
  }
  return { events, rest };
}

const parsed = (data: string): unknown => {
  try {
    return JSON.parse(data) as unknown;
  } catch (err) {
    throw new Hopeless(`root sent what is not an install's progress: ${(err as Error).message}`);
  }
};

export async function followInstall(follow: InstallFollow): Promise<FollowEnd> {
  const said = { section: false, title: undefined as string | undefined, line: undefined as string | undefined };
  let connected = false;
  const show = (followed: KoalaInstallFollowed): FollowEnd | undefined => {
    const { install } = followed;
    const doing = install.move ? MOVING : PUTTING;
    if (!said.section) {
      follow.section(doing);
      said.section = true;
    }
    if (install.state === 'ready') {
      follow.say(followed.url ? `Koala is ready at ${followed.url}` : 'Koala is ready; My Machines shows where it answers');
      return 'ready';
    }
    if (install.state === 'failed') {
      follow.say(`${doing} stopped${install.title ? ` at ${install.title}` : ''}: ${install.why ?? 'root gave no reason'}`);
      return 'failed';
    }
    if (install.title && install.title !== said.title) {
      follow.say(install.title);
      said.title = install.title;
      said.line = undefined;
    }
    if (install.line && install.line !== said.line) {
      follow.say(`  ${install.line}`);
      said.line = install.line;
    }
    return undefined;
  };

  const once = async (): Promise<FollowEnd> => {
    if (follow.interrupted.aborted) return 'interrupted';
    const quiet = new AbortController();
    const signal = AbortSignal.any([follow.interrupted, quiet.signal]);
    let quietTimer: NodeJS.Timeout | undefined;
    const heard = (): void => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => { quiet.abort(new Dropped(`root sent nothing for ${(QUIET_BEATS * KOALA_INSTALL_FOLLOW_BEAT_MS) / 1000} s`)); }, QUIET_BEATS * KOALA_INSTALL_FOLLOW_BEAT_MS);
    };
    const lost = (err: unknown): FollowEnd => {
      if (follow.interrupted.aborted) return 'interrupted';
      const why = quiet.signal.aborted ? reasonOf(quiet.signal.reason) : reasonOf(err);
      if (connected) follow.say(`The connection to root dropped (${why}); following again`);
      connected = false;
      throw new Dropped(why);
    };
    try {
      let response: Response;
      try {
        heard();
        response = await follow.fetch(rootUrlOf(follow.rootUrl, KOALA_INSTALL_FOLLOW_PATH), { headers: { authorization: `Bearer ${follow.token}`, accept: 'text/event-stream' }, signal });
      } catch (err) {
        if (!follow.interrupted.aborted && !quiet.signal.aborted && failureOf(err).kind === 'final') throw new Hopeless(`root could not be asked how putting Koala on this machine goes: ${reasonOf(err)}`, { cause: err });
        return lost(err);
      }
      if (response.status === 204) return 'none';
      if (response.status !== 200 || !response.body) {
        const text = (await response.text()).trim();
        if (statusFailure(response.status).kind === 'final') throw new Hopeless(`root would not say how putting Koala on this machine goes (${response.status}): ${text}`);
        throw new Dropped(`root answered ${response.status}: ${text}`);
      }
      connected = true;
      const decoder = new TextDecoder();
      let pending = '';
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          heard();
          const read = eventsOf(pending + decoder.decode(chunk, { stream: true }));
          pending = read.rest;
          for (const event of read.events) {
            if (event.kind === KOALA_INSTALL_FOLLOW_STOPPED) {
              const stopped = koalaInstallStoppedOf(parsed(event.data));
              if (!stopped.ok) throw new Hopeless(`root sent what is not a reason: ${stopped.problem}`);
              follow.say(stopped.why);
              return 'stopped';
            }
            const followed = koalaInstallFollowedOf(parsed(event.data));
            if (!followed.ok) throw new Hopeless(`root sent what is not an install's progress: ${followed.problem}`);
            const end = show(followed.value);
            if (end) return end;
          }
        }
      } catch (err) {
        if (err instanceof Hopeless) throw err;
        return lost(err);
      }
      return lost(new Error('root closed the connection before the install ended'));
    } finally {
      clearTimeout(quietTimer);
    }
  };

  return waitUntil('root to say how putting Koala on this machine goes', async () => {
    try {
      return await once();
    } catch (err) {
      if (err instanceof Hopeless) throw err;
      throw new Error(reasonOf(err));
    }
  }, undefined, { waiting: (_what, last) => { follow.say(`root cannot be reached yet${last ? ` (${last})` : ''}; following again`); }, ...follow.wait });
}
