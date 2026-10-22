import { describe, it, expect } from 'vitest';
import { claimSize, importLine, manifestVersion, moduleChanged, projectChoicesPatch, wrongVersionFrom, latestBuildOf, majorOf, missingFrom, missingSentence, odooVersionOfDockerfile, projectMajor, restorable, restoreJob, versionProblem } from './client-import.js';

describe('a client\'s Odoo backup', () => {
  it('is taken only from the project\'s own Odoo version, and never from hosted Odoo', () => {
    expect(majorOf({ version: '20.0+e', major_version: '20.0' })).toBe('20.0');
    expect(majorOf({ version: '18.0-20251001' })).toBe('18.0');
    expect(versionProblem({ major_version: '20.0' }, '20.0')).toBeUndefined();
    expect(versionProblem({ major_version: '17.0' }, '20.0')).toBe('the backup is from Odoo 17.0, and this project runs Odoo 20.0; moving a database from one Odoo version to another is a step of its own');
    expect(versionProblem({ major_version: 'saas~18.3' }, '20.0')).toContain('the backup is from hosted Odoo (saas~18.3)');
    expect(versionProblem(undefined, '20.0')).toBe('the file is not a backup made by Odoo\'s database manager: it has no manifest.json');
    expect(versionProblem({}, '20.0')).toBe('the backup\'s manifest.json does not say which Odoo it came from');
  });

  it('knows the project\'s Odoo from its tree or its Dockerfile', () => {
    expect(projectMajor('20')).toBe('20.0');
    expect(odooVersionOfDockerfile('# the app\nFROM odoo:18\nCOPY addons /mnt/extra-addons\n')).toBe('18.0');
    expect(odooVersionOfDockerfile('FROM docker.io/library/odoo:20.0')).toBe('20.0');
    expect(odooVersionOfDockerfile('FROM python:3.12')).toBeUndefined();
  });

  it('sizes the upload\'s volume with room to spare', () => {
    expect(claimSize(100 * 2 ** 20)).toBe('2Gi');
    expect(claimSize(5 * 2 ** 30)).toBe('7Gi');
  });

  it('reads the modules a restore found missing, and says what to do', () => {
    const missing = missingFrom('shop-restore-a failed:\nERROR missing modules: web_studio, sale_subscription\n');
    expect(missing).toEqual(['web_studio', 'sale_subscription']);
    expect(missingSentence(missing!)).toBe('the client\'s database has modules installed that this project does not: web_studio, sale_subscription. Put their code in the project\'s addons, or uninstall them in the client\'s Odoo and make a new backup');
    expect(missingFrom('psql broke')).toBeUndefined();
    expect(wrongVersionFrom('shop-restore-a failed:\nERROR wrong version: the backup is from Odoo 18.0, and this project\'s image runs Odoo 20.0\n')).toBe('the backup is from Odoo 18.0, and this project\'s image runs Odoo 20.0');
  });

  it('restores in the build\'s image with the upload mounted read-only, and neutralizes only a copy', () => {
    const job = restoreJob({ release: 'shop', image: 'reg/shop:one', database: 'odoo_a', mode: 'copy' }) as { spec: { template: { spec: { containers: { image: string; command: string[]; env: { name: string; value?: string }[]; volumeMounts: { name: string; readOnly?: boolean }[] }[]; volumes: { name: string; persistentVolumeClaim: { claimName: string } }[] } } } };
    const pod = job.spec.template.spec;
    const [container] = pod.containers;
    expect(container!.image).toBe('reg/shop:one');
    expect(container!.command.slice(0, 2)).toEqual(['python3', '-c']);
    expect(container!.command[2]).toContain("if mode == 'copy':");
    expect(container!.command[2]).toContain("'odoo', 'neutralize', '-d', db");
    expect(container!.env.find((entry) => entry.name === 'RESTORE_MODE')?.value).toBe('copy');
    expect(container!.env.find((entry) => entry.name === 'PGHOST')?.value).toBe('shop-postgres');
    expect(container!.volumeMounts).toContainEqual({ name: 'import', mountPath: '/import', readOnly: true });
    expect(pod.volumes.map((volume) => volume.persistentVolumeClaim.claimName)).toEqual(['shop-filestore', 'shop-import']);
  });

  it('restores an upload until one is imported, and finds the newest build to release it with', () => {
    expect(restorable({ state: 'uploaded', mode: 'copy', bytes: 1, version: '20.0', at: 'x' })).toBe(true);
    expect(restorable({ state: 'refused', mode: 'copy', bytes: 1, version: '20.0', missing: ['x'], at: 'x' })).toBe(true);
    expect(restorable({ state: 'imported', mode: 'copy', bytes: 1, version: '20.0', at: 'x' })).toBe(false);
    expect(restorable({ state: 'failed', mode: 'copy', bytes: 1, at: 'x' })).toBe(false);
    const runs = [
      { projectId: 'p1', status: 'succeeded', imageTag: 'one', startedAt: '1' },
      { projectId: 'p1', status: 'failed', startedAt: '3' },
      { projectId: 'p1', status: 'succeeded', imageTag: 'two', startedAt: '2' },
      { projectId: 'p2', status: 'succeeded', imageTag: 'x', startedAt: '9' },
    ];
    expect(latestBuildOf(runs, 'p1')?.imageTag).toBe('two');
  });

  it('tells Koala how the project started', () => {
    expect(importLine({ state: 'imported', mode: 'copy', bytes: 1, version: '20.0', modules: ['base', 'sale'], at: 'x' })).toBe('Started from the client\'s database (Odoo 20.0, 2 modules, as a neutralized copy). What was made in their app is listed by app_drift.');
    expect(importLine(undefined)).toBe('');
  });

  it('makes a planned project wait for the client\'s database, unless one is already on its way', () => {
    expect(projectChoicesPatch({ id: 'p1' }, { startsFrom: 'client-database', release: { agent: 'release' } }, 'now')).toEqual({ id: 'p1', release: { agent: 'release' }, clientImport: { state: 'awaited', mode: 'copy', bytes: 0, at: 'now' } });
    expect(projectChoicesPatch({ id: 'p1', clientImport: { state: 'imported', mode: 'copy', bytes: 1, at: 'x' } }, { startsFrom: 'client-database' }, 'now')).toEqual({ id: 'p1' });
    expect(projectChoicesPatch({ id: 'p1', clientImport: { state: 'refused', mode: 'copy', bytes: 1, at: 'x' } }, { startsFrom: 'client-database' }, 'now')).toMatchObject({ clientImport: { state: 'awaited' } });
  });

  it('reads a module\'s version from its manifest, and says whether it differs from what the client has installed', () => {
    expect(manifestVersion("{'name': 'X', 'version': '1.2.0', 'depends': []}")).toBe('1.2.0');
    expect(manifestVersion('{"version": "20.0.1.0"}')).toBe('20.0.1.0');
    expect(manifestVersion(null)).toBeUndefined();
    expect(moduleChanged('20.0.1.2.0', '1.2.0', '20.0')).toBe(false);
    expect(moduleChanged('20.0.1.2.0', '20.0.1.2.0', '20.0')).toBe(false);
    expect(moduleChanged('20.0.1.2.0', '1.3.0', '20.0')).toBe(true);
    expect(moduleChanged(undefined, '1.0', '20.0')).toBe(true);
  });
});
