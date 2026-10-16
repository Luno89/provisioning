import { odooJob, releaseLabels, type ReleaseVault } from './odoo-release.js';

export type ImportMode = 'copy' | 'live';
export type ImportState = 'uploading' | 'uploaded' | 'refused' | 'importing' | 'imported' | 'failed';

export interface ClientImport {
  state: ImportState;
  mode: ImportMode;
  bytes: number;
  version?: string | undefined;
  modules?: string[] | undefined;
  missing?: string[] | undefined;
  reason?: string | undefined;
  releaseId?: string | undefined;
  at: string;
}

export interface BackupManifest {
  version?: string;
  major_version?: string;
  modules?: Record<string, string>;
}

export const IMPORT_MOUNT = '/import';
export const IMPORT_FILE = `${IMPORT_MOUNT}/backup.zip`;
export const HOLDER_IMAGE = 'busybox:1.36.1';
export const MISSING_MARK = 'missing modules: ';
export const VERSION_MARK = 'wrong version: ';

export const importClaim = (release: string): string => `${release}-import`;
export const importHolder = (release: string): string => `${release}-import-holder`;

export const isImportMode = (value: unknown): value is ImportMode => value === 'copy' || value === 'live';

export const restorable = (entry: ClientImport | undefined): boolean =>
  Boolean(entry && (entry.state === 'uploaded' || entry.state === 'importing' || entry.state === 'refused' || entry.state === 'failed') && entry.version);

export function majorOf(manifest: BackupManifest): string | undefined {
  if (manifest.major_version) return manifest.major_version;
  const version = manifest.version?.trim();
  if (!version) return undefined;
  const match = version.match(/^(saas~)?(\d+)\.(\d+)/);
  return match ? `${match[1] ?? ''}${match[2]}.${match[3]}` : undefined;
}

export function projectMajor(version: string): string {
  return /^\d+$/.test(version) ? `${version}.0` : version;
}

export function versionProblem(manifest: BackupManifest | undefined, project: string): string | undefined {
  if (!manifest) return 'the file is not a backup made by Odoo\'s database manager: it has no manifest.json';
  const major = majorOf(manifest);
  if (!major) return 'the backup\'s manifest.json does not say which Odoo it came from';
  if (major.startsWith('saas')) {
    return `the backup is from hosted Odoo (${major}), which runs a version between Odoo's releases; a database has to be upgraded to a release, like ${project}, before it can run outside Odoo's own hosting, and importing from hosted Odoo is a step of its own`;
  }
  if (major !== project) return `the backup is from Odoo ${major}, and this project runs Odoo ${project}; moving a database from one Odoo version to another is a step of its own`;
  return undefined;
}

export function parseManifest(text: string): BackupManifest | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as BackupManifest : undefined;
  } catch {
    return undefined;
  }
}

export function claimSize(bytes: number): string {
  return `${Math.ceil((bytes * 1.2) / 2 ** 30) + 1}Gi`;
}

export function claimManifest(release: string, bytes: number): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: importClaim(release), labels: releaseLabels(release) },
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: claimSize(bytes) } } },
  };
}

export function holderManifest(release: string): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: importHolder(release), labels: releaseLabels(release) },
    spec: {
      restartPolicy: 'Never',
      containers: [{ name: 'holder', image: HOLDER_IMAGE, command: ['sleep', 'infinity'], volumeMounts: [{ name: 'import', mountPath: IMPORT_MOUNT }] }],
      volumes: [{ name: 'import', persistentVolumeClaim: { claimName: importClaim(release) } }],
    },
  };
}

export const RECEIVE_COMMAND = ['sh', '-c', `cat > ${IMPORT_FILE}.part && mv ${IMPORT_FILE}.part ${IMPORT_FILE}`];
export const MANIFEST_COMMAND = ['unzip', '-p', IMPORT_FILE, 'manifest.json'];
export const DISCARD_COMMAND = ['rm', '-f', IMPORT_FILE, `${IMPORT_FILE}.part`];

export function missingFrom(message: string): string[] | undefined {
  const at = message.indexOf(MISSING_MARK);
  if (at < 0) return undefined;
  return message.slice(at + MISSING_MARK.length).split('\n')[0]!.split(',').map((name) => name.trim()).filter(Boolean);
}

export function wrongVersionFrom(message: string): string | undefined {
  const at = message.indexOf(VERSION_MARK);
  return at < 0 ? undefined : message.slice(at + VERSION_MARK.length).split('\n')[0]!.trim();
}

export function missingSentence(missing: readonly string[]): string {
  return `the client's database has ${missing.length === 1 ? 'a module' : 'modules'} installed that this project does not: ${missing.join(', ')}. Put ${missing.length === 1 ? 'its' : 'their'} code in the project's addons, or uninstall ${missing.length === 1 ? 'it' : 'them'} in the client's Odoo and make a new backup`;
}

const RESTORE_SCRIPT = String.raw`
import json, os, shutil, subprocess, sys, uuid, zipfile
import odoo, odoo.addons
from odoo.tools import config
db = os.environ['RESTORE_DB']
mode = os.environ['RESTORE_MODE']
host = os.environ['PGHOST']
env = dict(os.environ, PGUSER='odoo', PGPASSWORD=os.environ['PASSWORD'])
backup = zipfile.ZipFile('${IMPORT_FILE}')
manifest = json.loads(backup.read('manifest.json'))
import odoo.release
image_major = odoo.release.major_version
backup_major = manifest.get('major_version') or '.'.join(str(manifest.get('version', '')).split('.')[:2])
if backup_major != image_major:
    print('ERROR ${VERSION_MARK}the backup is from Odoo %s, and this project\'s image runs Odoo %s' % (backup_major, image_major), flush=True)
    sys.exit(6)
config.parse_config(['-c', os.environ.get('ODOO_RC', '/etc/odoo/odoo.conf')])
configured = config.get('addons_path') or []
roots = [str(path).strip() for path in (configured.split(',') if isinstance(configured, str) else configured) if str(path).strip()] + list(odoo.addons.__path__)
missing = sorted(name for name in manifest.get('modules', {}) if not any(os.path.isfile(os.path.join(root, name, '__manifest__.py')) for root in roots))
if missing:
    print('ERROR ${MISSING_MARK}' + ', '.join(missing), flush=True)
    sys.exit(3)
subprocess.run(['dropdb', '--if-exists', db], env=env, check=True)
subprocess.run(['createdb', '--encoding=unicode', '--lc-collate=C', '--template=template0', db], env=env, check=True)
load = subprocess.Popen(['psql', '-q', '-d', db], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, env=env)
with backup.open('dump.sql') as dump:
    shutil.copyfileobj(dump, load.stdin, 1 << 20)
load.stdin.close()
if load.wait():
    print('ERROR the backup\'s dump.sql did not load into the database', flush=True)
    sys.exit(4)
store = os.path.realpath('/var/lib/odoo/filestore/' + db)
shutil.rmtree(store, ignore_errors=True)
files = 0
for member in backup.infolist():
    if not member.filename.startswith('filestore/') or member.is_dir():
        continue
    target = os.path.realpath(os.path.join(store, member.filename[len('filestore/'):]))
    if not target.startswith(store + os.sep):
        print('ERROR the backup names a file outside its filestore: ' + member.filename, flush=True)
        sys.exit(5)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with backup.open(member) as source, open(target, 'wb') as out:
        shutil.copyfileobj(source, out, 1 << 20)
    files += 1
if mode == 'copy':
    for key in ('database.uuid', 'database.secret'):
        subprocess.run(['psql', '-q', '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', "update ir_config_parameter set value = '%s' where key = '%s'" % (uuid.uuid4(), key)], env=env, check=True)
    subprocess.run(['odoo', 'neutralize', '-d', db, '--db_host=' + host, '--db_user=odoo', '--db_password=' + os.environ['PASSWORD'], '--data-dir=/var/lib/odoo'], check=True)
print('restored %s: %d modules, %d files, %s' % (db, len(manifest.get('modules', {})), files, 'a neutralized copy' if mode == 'copy' else 'as it was'), flush=True)
`;

export function restoreJob(input: { release: string; image: string; database: string; mode: ImportMode; vault?: ReleaseVault | undefined }): Record<string, unknown> {
  const base = odooJob({ name: '', release: input.release, image: input.image, database: input.database, install: [], update: [], vault: input.vault }) as {
    spec: { template: { spec: { containers: Record<string, unknown>[]; volumes: Record<string, unknown>[] } } };
  };
  const pod = base.spec.template.spec;
  const container = pod.containers[0]!;
  const env = (container.env as Record<string, unknown>[]).filter((entry) => entry.name === 'PASSWORD');
  pod.containers = [{
    name: 'restore',
    image: input.image,
    command: ['python3', '-c', RESTORE_SCRIPT],
    env: [...env, { name: 'RESTORE_DB', value: input.database }, { name: 'RESTORE_MODE', value: input.mode }, { name: 'PGHOST', value: `${input.release}-postgres` }],
    volumeMounts: [...(container.volumeMounts as Record<string, unknown>[]), { name: 'import', mountPath: IMPORT_MOUNT, readOnly: true }],
  }];
  pod.volumes = [...pod.volumes, { name: 'import', persistentVolumeClaim: { claimName: importClaim(input.release) } }];
  return base as unknown as Record<string, unknown>;
}

export function importedSentence(entry: { mode: ImportMode; version?: string | undefined; modules: number }): string {
  const how = entry.mode === 'copy' ? 'as a copy to work on, with its mail, scheduled jobs and payments switched off' : 'as your live system, with its mail and scheduled jobs running';
  return `The client's database (Odoo ${entry.version ?? '?'}, ${entry.modules} modules) is live in slot a, ${how}`;
}

export function odooVersionOfDockerfile(text: string | null): string | undefined {
  const match = text?.match(/^\s*FROM\s+(?:\S+\/)?odoo:(\d+)(?:\.0)?\b/im);
  return match ? projectMajor(match[1]!) : undefined;
}

export function latestBuildOf<T extends { projectId: string; status: string; imageTag?: string | undefined; startedAt: string }>(runs: readonly T[], projectId: string): T | undefined {
  return runs.filter((run) => run.projectId === projectId && run.status === 'succeeded' && run.imageTag).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

export function importLine(entry: ClientImport | undefined): string {
  if (!entry) return '';
  const what = `the client's database (Odoo ${entry.version ?? '?'}, ${entry.modules?.length ?? 0} modules, ${entry.mode === 'copy' ? 'as a neutralized copy' : 'as their live system'})`;
  switch (entry.state) {
    case 'uploading': return `Started from a client's database: it is being uploaded.`;
    case 'uploaded': return `Starts from ${what}: uploaded, and restored into slot a by the project's first release.`;
    case 'importing': return `Starts from ${what}: being restored into slot a.`;
    case 'imported': return `Started from ${what}. What was made in their app is listed by app_drift.`;
    case 'refused': return `Starting from a client's database was refused: ${entry.reason ?? 'no reason was given'}.`;
    case 'failed': return `Starting from a client's database failed: ${entry.reason ?? 'no reason was given'}.`;
  }
}
