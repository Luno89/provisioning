import { DEPENDENCY_NAME, LANGUAGE_IDS, type Contribution } from '@koala/agent-engine';

export const WORKSPACE_FILE = '.koala/workspace.json';
export const FROM_PROJECT = 'project';

export const PACKAGE_MANAGERS = ['dnf', 'apt', 'pip', 'npm'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export interface WorkspaceFile {
  packages?: Partial<Record<PackageManager, string[]>> | undefined;
  script?: string | undefined;
  languages?: string[] | undefined;
  env?: { name: string; value: string }[] | undefined;
  needs?: string[] | undefined;
}

export type ReadWorkspaceFile =
  | { file: WorkspaceFile }
  | { problems: string[] };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PACKAGE = /^[A-Za-z0-9@][A-Za-z0-9@._+:/=<>~^-]*$/;
const SECRET_LIKE = /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function workspaceFileProblems(value: unknown): string[] {
  if (!isRecord(value)) return [`${WORKSPACE_FILE} has to be a JSON object`];
  const problems: string[] = [];
  const known = new Set(['packages', 'script', 'languages', 'needs', 'env']);
  for (const key of Object.keys(value)) if (!known.has(key)) problems.push(`"${key}" is not something ${WORKSPACE_FILE} can say; it can say ${[...known].join(', ')}`);

  if (value.packages !== undefined) {
    if (!isRecord(value.packages)) problems.push('packages has to be an object of lists, by package manager');
    else {
      for (const [manager, listed] of Object.entries(value.packages)) {
        if (!(PACKAGE_MANAGERS as readonly string[]).includes(manager)) {
          problems.push(`"${manager}" is not a package manager it can use; it can use ${PACKAGE_MANAGERS.join(', ')}`);
          continue;
        }
        if (!Array.isArray(listed) || listed.some((name) => typeof name !== 'string')) {
          problems.push(`packages.${manager} has to be a list of package names`);
          continue;
        }
        for (const name of listed as string[]) if (!PACKAGE.test(name)) problems.push(`"${name}" in packages.${manager} is not a package name`);
      }
    }
  }

  if (value.needs !== undefined) {
    if (!Array.isArray(value.needs) || value.needs.some((need) => typeof need !== 'string')) problems.push('needs has to be a list of dependency names');
    else for (const need of value.needs as string[]) if (!DEPENDENCY_NAME.test(need)) problems.push(`"${need}" in needs is not a dependency name`);
  }

  if (value.script !== undefined && (typeof value.script !== 'string' || !value.script.trim())) problems.push('script has to be the shell commands to run, as one string');

  if (value.languages !== undefined) {
    if (!Array.isArray(value.languages) || value.languages.some((language) => typeof language !== 'string')) problems.push('languages has to be a list of language names');
    else for (const language of value.languages as string[]) if (!LANGUAGE_IDS.includes(language)) problems.push(`"${language}" is not a language a workspace can have; it can have ${LANGUAGE_IDS.join(', ')}`);
  }

  if (value.env !== undefined) {
    if (!Array.isArray(value.env)) problems.push('env has to be a list of { name, value }');
    else {
      for (const entry of value.env) {
        if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.value !== 'string') {
          problems.push('each env entry needs a name and a value, both text');
          continue;
        }
        if (!ENV_NAME.test(entry.name)) problems.push(`"${entry.name}" is not an environment variable name`);
        if (SECRET_LIKE.test(entry.name)) problems.push(`"${entry.name}" looks like a secret, and secrets never go in ${WORKSPACE_FILE}: a model works in this workspace`);
      }
    }
  }

  return problems;
}

export function readWorkspaceFile(text: string | undefined): ReadWorkspaceFile {
  if (text === undefined || !text.trim()) return { file: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { problems: [`${WORKSPACE_FILE} is not JSON: ${(err as Error).message}`] };
  }
  const problems = workspaceFileProblems(parsed);
  return problems.length > 0 ? { problems } : { file: parsed as WorkspaceFile };
}

export function writeWorkspaceFile(file: WorkspaceFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function contributionsOf(file: WorkspaceFile): Contribution[] {
  const contributions: Contribution[] = [];
  for (const manager of PACKAGE_MANAGERS) {
    const packages = file.packages?.[manager] ?? [];
    if (packages.length > 0) contributions.push({ from: FROM_PROJECT, install: { via: manager, packages: [...packages] } });
  }
  if (file.script?.trim()) contributions.push({ from: FROM_PROJECT, install: { via: 'script', run: file.script.trim() } });
  return contributions;
}

export function scriptOf(file: WorkspaceFile): string | undefined {
  return file.script?.trim() || undefined;
}

export interface WorkspaceChange {
  packages?: Partial<Record<PackageManager, string[]>> | undefined;
  languages?: string[] | undefined;
  env?: { name: string; value: string }[] | undefined;
  script?: string | undefined;
  needs?: string[] | undefined;
}

export type ChangedWorkspaceFile =
  | { file: WorkspaceFile; added: string[] }
  | { problems: string[] };

const union = (before: readonly string[] | undefined, more: readonly string[] | undefined): string[] => [...new Set([...(before ?? []), ...(more ?? [])])];

export function withChange(file: WorkspaceFile, change: WorkspaceChange): ChangedWorkspaceFile {
  const added: string[] = [];
  const packages: Partial<Record<PackageManager, string[]>> = { ...(file.packages ?? {}) };
  for (const manager of PACKAGE_MANAGERS) {
    const fresh = (change.packages?.[manager] ?? []).filter((name) => !(packages[manager] ?? []).includes(name));
    if (fresh.length === 0) continue;
    packages[manager] = union(packages[manager], fresh);
    added.push(`${manager} ${fresh.join(', ')}`);
  }
  const languages = (change.languages ?? []).filter((language) => !(file.languages ?? []).includes(language));
  if (languages.length) added.push(`the ${languages.join(', ')} language${languages.length === 1 ? '' : 's'}`);
  const env = [...(file.env ?? [])];
  for (const entry of change.env ?? []) {
    const at = env.findIndex((own) => own.name === entry.name);
    if (at >= 0 && env[at]!.value === entry.value) continue;
    if (at >= 0) env[at] = entry; else env.push(entry);
    added.push(`${entry.name}=${entry.value}`);
  }
  const asked = change.script?.trim();
  const freshScript = asked && !(file.script ?? '').includes(asked) ? asked : undefined;
  const script = freshScript ? [file.script?.trim(), freshScript].filter(Boolean).join('\n') : file.script;
  if (freshScript) added.push('an install script');
  const needs = (change.needs ?? []).filter((need) => !(file.needs ?? []).includes(need));
  if (needs.length) added.push(`the ${needs.join(', ')} dependenc${needs.length === 1 ? 'y' : 'ies'}`);

  const next: WorkspaceFile = {
    ...(Object.keys(packages).length ? { packages } : {}),
    ...(script ? { script } : {}),
    ...(file.languages || languages.length ? { languages: union(file.languages, languages) } : {}),
    ...(env.length ? { env } : {}),
    ...(file.needs || needs.length ? { needs: union(file.needs, needs) } : {}),
  };
  const problems = workspaceFileProblems(next);
  return problems.length > 0 ? { problems } : { file: next, added };
}

export function pendingChanges(published: WorkspaceFile | undefined, onMain: WorkspaceFile): string[] {
  if (!published) return [];
  const changed = withChange(published, {
    packages: onMain.packages,
    languages: onMain.languages,
    env: onMain.env,
    script: onMain.script,
    needs: onMain.needs,
  });
  return 'added' in changed ? changed.added : [];
}
