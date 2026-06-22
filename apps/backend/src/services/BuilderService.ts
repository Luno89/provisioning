import { BaseService } from './BaseService.js';
import fs from 'fs/promises';
import path from 'path';
import { InfrastructureService } from './InfrastructureService.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../../../');

/**
 * Service to build custom Odoo images with selected modules.
 */
export class BuilderService extends BaseService {
  private infra: InfrastructureService;
  private buildContext = '/tmp/odoo-build';

  constructor(db: any, infra: InfrastructureService) {
    super(db);
    this.infra = infra;
  }

  async buildCustomImage(baseImage: string, modules: string[], options: any = {}) {
    const { io, resourceId } = options;
    const buildId = Date.now();
    const tag = `odoo-custom:${resourceId.slice(0, 8)}-${buildId}`;
    
    const sourceRepo = path.join(PROJECT_ROOT, '../odoo-custom-modules');

    this.logger.info(`Building custom image ${tag} from ${baseImage}`);
    if (io && resourceId) io.to(resourceId).emit('log', `\n--- STARTING BUILD: ${tag} ---\n`);

    // 1. Pre-flight Validation
    if (io && resourceId) io.to(resourceId).emit('log', `Running pre-flight validation on modules...\n`);
    for (const modId of modules) {
        try {
            const validatorPath = path.join(sourceRepo, 'validate.py');
            const modPath = path.join(sourceRepo, modId);
            const { stdout } = await this.infra.runCommand('python3', [validatorPath, modPath], 'validate', options);
            if (io && resourceId) io.to(resourceId).emit('log', `✅ Module ${modId}: OK\n`);
        } catch (err: any) {
            const errorMsg = `\n🚨 VALIDATION FAILED for module "${modId}":\n${err.stdout || err.message}\n`;
            if (io && resourceId) io.to(resourceId).emit('log', errorMsg);
            throw new Error(`Module validation failed: ${modId}`);
        }
    }

    await fs.mkdir(this.buildContext, { recursive: true });
    
    // 2. Prepare Addons directory
    const addonsDir = path.join(this.buildContext, 'addons');
    await fs.rm(addonsDir, { recursive: true, force: true });
    await fs.mkdir(addonsDir, { recursive: true });
    
    // 3. Copy selected modules
    for (const modId of modules) {
        const src = path.join(sourceRepo, modId);
        const dest = path.join(addonsDir, modId);
        await this.infra.runCommand('cp', ['-r', src, dest], 'copy-mod', { ...options, env: { CD_DIR: this.buildContext } });
    }

    // 4. Create Dockerfile
    const dockerfile = `
FROM ${baseImage}
USER root
COPY ./addons /mnt/extra-addons
RUN chown -R odoo:odoo /mnt/extra-addons
USER odoo
`;

    // 5. Run Docker Build
    await this.infra.buildImage(tag, dockerfile, this.buildContext, options);

    this.logger.info(`Successfully built ${tag}`);
    if (io && resourceId) io.to(resourceId).emit('log', `\n--- BUILD COMPLETE: ${tag} ---\n`);
    return tag;
  }
}
