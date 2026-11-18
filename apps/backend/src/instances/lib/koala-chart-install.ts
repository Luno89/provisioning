export interface InstallArgs {
  kubeconfig: string;
  release: string;
  namespace: string;
  chart: string;
  values: string[];
}

const NAMED = { '--kubeconfig': 'kubeconfig', '--release': 'release', '--namespace': 'namespace', '--chart': 'chart' } as const;

const MEANT: Record<keyof typeof NAMED, string> = {
  '--kubeconfig': '--kubeconfig names the cluster\'s kubeconfig file',
  '--release': '--release names the helm release',
  '--namespace': '--namespace names the release\'s namespace',
  '--chart': '--chart names the chart, a folder or a packaged .tgz',
};

const WAITING = new Set(['--wait', '--wait-for-jobs', '--timeout', '--atomic']);

export const KOALA_CHART_STEP = { id: 'koala', title: 'Putting Koala on its cluster' } as const;

export function installArgsOf(argv: readonly string[]): InstallArgs {
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const values = split === -1 ? [] : argv.slice(split + 1);
  const found: Partial<Record<(typeof NAMED)[keyof typeof NAMED], string>> = {};
  for (let at = 0; at < own.length; at += 2) {
    const flag = own[at]!;
    if (!(flag in NAMED)) throw new Error(`${flag} is not taken: helm values go after --`);
    const value = own[at + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(MEANT[flag as keyof typeof NAMED]);
    found[NAMED[flag as keyof typeof NAMED]] = value;
  }
  for (const [flag, key] of Object.entries(NAMED)) if (!found[key]) throw new Error(MEANT[flag as keyof typeof NAMED]);
  if (values.some((arg) => WAITING.has(arg.split('=')[0]!))) throw new Error('helm is never told to wait or given a time limit: Koala follows the rollout itself');
  return { kubeconfig: found.kubeconfig!, release: found.release!, namespace: found.namespace!, chart: found.chart!, values: [...values] };
}

export function valuesFilesIn(values: readonly string[]): string[] {
  const files: string[] = [];
  values.forEach((arg, at) => {
    const next = values[at + 1];
    if ((arg === '-f' || arg === '--values') && next !== undefined) files.push(next);
    if (arg === '--set-file' && next !== undefined) files.push(...next.split(',').map((pair) => pair.slice(pair.indexOf('=') + 1)));
  });
  return files;
}
