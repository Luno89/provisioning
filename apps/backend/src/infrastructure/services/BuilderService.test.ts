import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { Server as SocketServer } from 'socket.io';
import { CommandFailedError } from '../../platform/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { BuilderService } from './BuilderService.js';
import type { InfrastructureService } from './InfrastructureService.js';

function builder() {
  const root = mkdtempSync(join(tmpdir(), 'builder-'));
  const buildContext = join(root, 'context');
  const sourceRoot = join(root, 'sources');
  mkdirSync(sourceRoot);
  const infra = mock<InfrastructureService>();
  infra.runCommand.mockResolvedValue({ stdout: '', logFile: 'x.log' });
  infra.buildImage.mockResolvedValue({ stdout: '', logFile: 'x.log' });
  return { infra, buildContext, sourceRoot, service: new BuilderService(memoryDatabase(), infra, { buildContext, sourceRoot }) };
}

describe('BuilderService.buildCustomImage', () => {
  it('writes stand-in modules and builds an Odoo image that copies them into its addons path when the modules\' repository is not here', async () => {
    const { infra, buildContext, service } = builder();
    const tag = await service.buildCustomImage('odoo:18', ['sale_extra'], 'odoo');
    expect(tag).toMatch(/^odoo-custom:build-\d+$/);
    expect(readFileSync(join(buildContext, 'addons', 'sale_extra', '__manifest__.py'), 'utf8')).toContain("'name': 'sale_extra'");
    expect(infra.buildImage).toHaveBeenCalledWith(tag, matches<string>((dockerfile) => dockerfile.includes('FROM odoo:18') && dockerfile.includes('RUN cp -r /tmp/addons/* /mnt/extra-addons/')), buildContext, {});
    expect(infra.runCommand).not.toHaveBeenCalled();
  });

  it('names the image after the app type and the deployment, and writes the right stand-in for a WordPress plugin or a Nextcloud app', async () => {
    const { service, buildContext } = builder();
    expect(await service.buildCustomImage('wordpress:6', ['seo'], 'WordPress', { resourceId: 'abcdef123456' })).toMatch(/^wordpress-custom:abcdef12-\d+$/);
    expect(readFileSync(join(buildContext, 'addons', 'seo', 'seo.php'), 'utf8')).toContain('Plugin Name: seo');
    await service.buildCustomImage('nextcloud:29', ['notes'], 'nextcloud');
    expect(readFileSync(join(buildContext, 'addons', 'notes', 'appinfo', 'info.xml'), 'utf8')).toContain('<id>notes</id>');
    await service.buildCustomImage('jellyfin/jellyfin', ['skin'], 'jellyfin');
    expect(readFileSync(join(buildContext, 'addons', 'skin', 'metadata.txt'), 'utf8')).toContain('skin');
  });

  it('copies the modules from the repository when it is here, validating each first when it has a validator', async () => {
    const { infra, sourceRoot, buildContext, service } = builder();
    const repo = join(sourceRoot, 'odoo-custom-modules');
    mkdirSync(join(repo, 'sale_extra'), { recursive: true });
    writeFileSync(join(repo, 'validate.py'), '');
    await service.buildCustomImage('odoo:18', ['sale_extra'], 'odoo');
    expect(infra.runCommand).toHaveBeenCalledWith('python3', [join(repo, 'validate.py'), join(repo, 'sale_extra')], 'validate', {});
    expect(infra.runCommand).toHaveBeenCalledWith('cp', ['-r', join(repo, 'sale_extra'), join(buildContext, 'addons', 'sale_extra')], 'copy-mod', { env: { CD_DIR: buildContext } });
  });

  it('copies the modules without validating them when the repository has no validator', async () => {
    const { infra, sourceRoot, service } = builder();
    mkdirSync(join(sourceRoot, 'odoo-custom-modules', 'sale_extra'), { recursive: true });
    await service.buildCustomImage('odoo:18', ['sale_extra'], 'odoo');
    expect(infra.runCommand).toHaveBeenCalledTimes(1);
    expect(infra.runCommand).toHaveBeenCalledWith('cp', expect.anything(), 'copy-mod', expect.anything());
  });

  it('refuses a module the validator rejects, saying what it printed, and builds nothing', async () => {
    const { infra, sourceRoot, service } = builder();
    const repo = join(sourceRoot, 'odoo-custom-modules');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'validate.py'), '');
    infra.runCommand.mockRejectedValue(new CommandFailedError('python3', 1, 'missing __init__.py', '', 'x.log'));
    const io = mock<SocketServer>();
    const lines: string[] = [];
    io.to.mockReturnValue({ emit: (event: string, line: string) => lines.push(`${event} ${line}`) } as never);
    await expect(service.buildCustomImage('odoo:18', ['bad'], 'odoo', { io, resourceId: 'r1' })).rejects.toThrow('Module validation failed: bad');
    expect(lines.join('')).toContain('VALIDATION FAILED for module "bad"');
    expect(lines.join('')).toContain('missing __init__.py');
    expect(infra.buildImage).not.toHaveBeenCalled();
  });

  it('streams its progress to the room of the deployment being built', async () => {
    const { service } = builder();
    const io = mock<SocketServer>();
    const lines: string[] = [];
    io.to.calledWith('r1').mockReturnValue({ emit: (event: string, line: string) => lines.push(line) } as never);
    await service.buildCustomImage('odoo:18', ['m'], 'odoo', { io, resourceId: 'r1' });
    expect(lines[0]).toMatch(/STARTING BUILD: odoo-custom:r1-\d+/);
    expect(lines.at(-1)).toMatch(/BUILD COMPLETE/);
  });

  it('lets a failed image build fail the build', async () => {
    const { infra, service } = builder();
    infra.buildImage.mockRejectedValue(new Error('docker build failed'));
    await expect(service.buildCustomImage('odoo:18', ['m'], 'odoo')).rejects.toThrow('docker build failed');
  });
});
