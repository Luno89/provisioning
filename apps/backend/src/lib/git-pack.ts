export interface RefUpdate {
  old: string;
  next: string;
  ref: string;
}

export type PushCommands = { ok: true; updates: RefUpdate[] } | { ok: false; why: string };

export function pushCommands(body: Buffer): PushCommands {
  const updates: RefUpdate[] = [];
  let at = 0;
  for (;;) {
    if (at + 4 > body.length) return { ok: false, why: 'the push ended before its commands did' };
    const size = Number.parseInt(body.subarray(at, at + 4).toString('ascii'), 16);
    if (!Number.isFinite(size)) return { ok: false, why: 'the push does not start with git\'s commands' };
    if (size === 0) return updates.length ? { ok: true, updates } : { ok: false, why: 'the push changes nothing' };
    if (size < 4 || at + size > body.length) return { ok: false, why: 'a command in the push is cut short' };
    const line = body.subarray(at + 4, at + size).toString('utf8').split('\0')[0]!.replace(/\n$/, '');
    const [old, next, ref, ...rest] = line.split(' ');
    if (!old || !next || !ref || rest.length) return { ok: false, why: `the push has a command git does not send: ${line.slice(0, 80)}` };
    updates.push({ old, next, ref });
    at += size;
  }
}
