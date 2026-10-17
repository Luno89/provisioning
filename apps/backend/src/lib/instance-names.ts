export const RESERVED_NAMES: readonly string[] = [
  'app', 'mesh', 'www', 'api', 'root', 'admin', 'registry', 'mail', 'smtp', 'imap', 'status', 'docs', 'help',
  'support', 'koala', 'auth', 'login', 'id', 'identity', 'static', 'assets', 'cdn', 'ns', 'ns1', 'ns2', 'mx',
];

const NAME = /^[a-z][a-z0-9]{2,19}$/;

export function nameProblem(name: string, siteNames: readonly string[] = []): string | null {
  if (name.includes('-')) return 'a name has no dashes: your apps are addressed <app>-<name>, so a dash would make it unclear whose an app is';
  if (!NAME.test(name)) return 'a name is 3 to 20 lowercase letters and digits, starting with a letter';
  if (RESERVED_NAMES.includes(name) || siteNames.includes(name)) return `"${name}" is kept for the platform itself`;
  return null;
}

export function suggestedName(email: string): string {
  const local = (email.split('@')[0] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const lettered = local.replace(/^[0-9]+/, '');
  const base = lettered.slice(0, 20);
  return base.length >= 3 && !RESERVED_NAMES.includes(base) ? base : `${base}home`.slice(0, 20);
}
