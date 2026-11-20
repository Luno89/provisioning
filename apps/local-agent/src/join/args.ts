import { ADAPTER_CHOICES, type AdapterChoice } from '../agent-setup.js';

export interface JoinArgs {
  code: string;
  url: string;
  yes: boolean;
  folder?: string;
  service: boolean;
  cluster: boolean;
  adapters: AdapterChoice;
  k3sMirror?: string;
  imageMirrors: Record<string, string>;
}

export class JoinUsage extends Error {}

const VALUED = new Set(['--folder', '--adapters', '--url', '--k3s-mirror', '--image-mirror']);
const IMAGE_MIRROR = /^([a-z0-9.-]+(?::[0-9]+)?)=(https?:\/\/\S+)$/;

export function joinArgsOf(argv: readonly string[]): JoinArgs {
  let code = '';
  let url = '';
  let yes = false;
  let folder: string | undefined;
  let service = true;
  let cluster = true;
  let adapters: string | undefined;
  let k3sMirror: string | undefined;
  const imageMirrors: Record<string, string> = {};
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]!;
    if (VALUED.has(arg)) {
      const value = argv[at + 1];
      if (value === undefined) throw new JoinUsage(`${arg} needs a value`);
      at += 1;
      if (arg === '--folder') folder = value;
      else if (arg === '--adapters') adapters = value;
      else if (arg === '--url') url = value;
      else if (arg === '--image-mirror') {
        const match = IMAGE_MIRROR.exec(value);
        if (!match) throw new JoinUsage('--image-mirror takes <registry>=<url>, for example docker.io=http://127.0.0.1:5101');
        imageMirrors[match[1]!] = match[2]!;
      } else k3sMirror = value;
    } else if (arg === '--yes') yes = true;
    else if (arg === '--no-service') service = false;
    else if (arg === '--no-cluster') cluster = false;
    else if (arg === '--') continue;
    else if (arg.startsWith('-')) throw new JoinUsage(`unknown option ${arg}`);
    else code = arg;
  }
  if (!url) throw new JoinUsage('--url names the Koala to join');
  const chosen = adapters ?? (yes ? 'all' : 'ask');
  if (!ADAPTER_CHOICES.includes(chosen as AdapterChoice)) throw new JoinUsage(`--adapters takes ${ADAPTER_CHOICES.join(', ')}`);
  if (!code) throw new JoinUsage(`usage: curl -fsSL ${url}/machine.sh | sh -s -- <code from My Machines>`);
  return {
    code,
    url: url.replace(/\/+$/, ''),
    yes,
    service,
    cluster,
    adapters: chosen as AdapterChoice,
    ...(folder !== undefined ? { folder } : {}),
    ...(k3sMirror !== undefined ? { k3sMirror } : {}),
    imageMirrors,
  };
}
