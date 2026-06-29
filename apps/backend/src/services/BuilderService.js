"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BuilderService = void 0;
const BaseService_js_1 = require("./BaseService.js");
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const url_1 = require("url");
const __filename = (0, url_1.fileURLToPath)(import.meta.url);
const __dirname = path_1.default.dirname(__filename);
const PROJECT_ROOT = path_1.default.resolve(__dirname, '../../../../');
class BuilderService extends BaseService_js_1.BaseService {
    infra;
    buildContext = '/tmp/app-build';
    constructor(db, infra) {
        super(db);
        this.infra = infra;
    }
    async buildCustomImage(baseImage, modules, appType = 'odoo', options = {}) {
        const { io, resourceId } = options;
        const buildId = Date.now();
        const sanitizedAppType = appType ? appType.toLowerCase() : 'odoo';
        const tag = `${sanitizedAppType}-custom:${resourceId.slice(0, 8)}-${buildId}`;
        const folderName = sanitizedAppType === 'odoo' ? 'odoo-custom-modules' : `${sanitizedAppType}-custom-plugins`;
        const sourceRepo = path_1.default.join(PROJECT_ROOT, '..', folderName);
        this.logger.info(`Building custom ${sanitizedAppType} image ${tag} from ${baseImage}`);
        if (io && resourceId)
            io.to(resourceId).emit('log', `\n--- STARTING BUILD: ${tag} ---\n`);
        // 1. Check if git repo exists
        let repoExists = false;
        try {
            await promises_1.default.access(sourceRepo);
            repoExists = true;
        }
        catch {
            repoExists = false;
        }
        // 2. Pre-flight Validation (only if validator script exists)
        const validatorPath = path_1.default.join(sourceRepo, 'validate.py');
        let hasValidator = false;
        if (repoExists) {
            try {
                await promises_1.default.access(validatorPath);
                hasValidator = true;
            }
            catch {
                hasValidator = false;
            }
        }
        if (hasValidator) {
            if (io && resourceId)
                io.to(resourceId).emit('log', `Running pre-flight validation on modules...\n`);
            for (const modId of modules) {
                try {
                    const modPath = path_1.default.join(sourceRepo, modId);
                    await this.infra.runCommand('python3', [validatorPath, modPath], 'validate', options);
                    if (io && resourceId)
                        io.to(resourceId).emit('log', `✅ Module ${modId}: OK\n`);
                }
                catch (err) {
                    const errorMsg = `\n🚨 VALIDATION FAILED for module "${modId}":\n${err.stdout || err.message}\n`;
                    if (io && resourceId)
                        io.to(resourceId).emit('log', errorMsg);
                    throw new Error(`Module validation failed: ${modId}`);
                }
            }
        }
        else {
            if (io && resourceId)
                io.to(resourceId).emit('log', `Skipping validation (no validator script found)\n`);
        }
        await promises_1.default.mkdir(this.buildContext, { recursive: true });
        // 3. Prepare Addons/Plugins directory in build context
        const addonsDir = path_1.default.join(this.buildContext, 'addons');
        await promises_1.default.rm(addonsDir, { recursive: true, force: true });
        await promises_1.default.mkdir(addonsDir, { recursive: true });
        // 4. Copy modules or write mock files if directory is missing
        if (repoExists) {
            if (io && resourceId)
                io.to(resourceId).emit('log', `Copying custom extensions from repository...\n`);
            for (const modId of modules) {
                const src = path_1.default.join(sourceRepo, modId);
                const dest = path_1.default.join(addonsDir, modId);
                await this.infra.runCommand('cp', ['-r', src, dest], 'copy-mod', { ...options, env: { CD_DIR: this.buildContext } });
            }
        }
        else {
            if (io && resourceId)
                io.to(resourceId).emit('log', `Writing mock extensions for clean installation...\n`);
            for (const modId of modules) {
                const destModDir = path_1.default.join(addonsDir, modId);
                await promises_1.default.mkdir(destModDir, { recursive: true });
                if (sanitizedAppType === 'odoo') {
                    const manifestContent = `{\n  'name': '${modId}',\n  'version': '1.0',\n  'summary': 'Mock module for testing',\n  'author': 'Local Test'\n}\n`;
                    await promises_1.default.writeFile(path_1.default.join(destModDir, '__manifest__.py'), manifestContent);
                }
                else if (sanitizedAppType === 'wordpress') {
                    const pluginContent = `<?php\n/*\nPlugin Name: ${modId}\nVersion: 1.0\nAuthor: Local Test\n*/\n`;
                    await promises_1.default.writeFile(path_1.default.join(destModDir, `${modId}.php`), pluginContent);
                }
                else if (sanitizedAppType === 'nextcloud') {
                    const infoContent = `<?xml version="1.0"?><info><id>${modId}</id><name>${modId}</name><author>Local Test</author><version>1.0</version></info>`;
                    const appinfoDir = path_1.default.join(destModDir, 'appinfo');
                    await promises_1.default.mkdir(appinfoDir, { recursive: true });
                    await promises_1.default.writeFile(path_1.default.join(appinfoDir, 'info.xml'), infoContent);
                }
                else {
                    await promises_1.default.writeFile(path_1.default.join(destModDir, 'metadata.txt'), `Mock metadata for extension ${modId}`);
                }
            }
        }
        // 5. Select copy destination inside Nginx/App container based on appType
        let destPaths = [];
        if (sanitizedAppType === 'odoo') {
            destPaths = ['/mnt/extra-addons'];
        }
        else if (sanitizedAppType === 'wordpress') {
            // Copy to both bitnami path (Helm) and standard apache path (Native) to ensure compatibility
            destPaths = ['/opt/bitnami/wordpress/wp-content/plugins', '/var/www/html/wp-content/plugins', '/usr/src/wordpress/wp-content/plugins'];
        }
        else if (sanitizedAppType === 'nextcloud') {
            destPaths = ['/opt/bitnami/nextcloud/custom_apps', '/var/www/html/custom_apps', '/var/www/html/apps'];
        }
        else if (sanitizedAppType === 'audiobookshelf') {
            destPaths = ['/metadata/plugins'];
        }
        else if (sanitizedAppType === 'prometheus') {
            destPaths = ['/etc/prometheus/plugins'];
        }
        else if (sanitizedAppType === 'traefik') {
            destPaths = ['/plugins-local'];
        }
        // Build the Dockerfile instructions to copy to all potential paths (creating folders first if needed)
        let copyInstructions = '';
        for (const dest of destPaths) {
            copyInstructions += `RUN mkdir -p ${dest}\nCOPY ./addons /tmp/addons\nRUN cp -r /tmp/addons/* ${dest}/ && rm -rf /tmp/addons\n`;
        }
        // 6. Create Dockerfile
        const dockerfile = `
FROM ${baseImage}
USER root
${copyInstructions}
`;
        // 7. Run Docker Build
        await this.infra.buildImage(tag, dockerfile, this.buildContext, options);
        this.logger.info(`Successfully built custom image ${tag}`);
        if (io && resourceId)
            io.to(resourceId).emit('log', `\n--- BUILD COMPLETE: ${tag} ---\n`);
        return tag;
    }
}
exports.BuilderService = BuilderService;
//# sourceMappingURL=BuilderService.js.map