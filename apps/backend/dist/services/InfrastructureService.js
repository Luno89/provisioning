"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InfrastructureService = void 0;
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const promises_1 = __importDefault(require("fs/promises"));
const fs_1 = require("fs");
const util_1 = require("util");
const url_1 = require("url");
const os_1 = __importDefault(require("os"));
const execAsync = (0, util_1.promisify)(child_process_1.exec);
const __filename = (0, url_1.fileURLToPath)(import.meta.url);
const __dirname = path_1.default.dirname(__filename);
const PROJECT_ROOT = path_1.default.resolve(__dirname, '../../../../');
const CDKTF_DIR = path_1.default.join(PROJECT_ROOT, 'packages/cdktf-infra');
const LOG_DIR = path_1.default.join(PROJECT_ROOT, 'apps/backend/data/logs');
const BIN_DIR = path_1.default.join(PROJECT_ROOT, 'bin');
const DEFAULT_KUBECONFIG = path_1.default.join(os_1.default.homedir(), '.kube/config');
/**
 * Service to handle low-level infrastructure commands.
 */
class InfrastructureService {
    activeStreams = new Map();
    getLogPath(logId) {
        return path_1.default.join(LOG_DIR, `${logId}-${Date.now()}.log`);
    }
    async deploy(stackName, options = {}) {
        return this.runCommand('npx', ['cdktf', 'deploy', stackName, '--auto-approve'], stackName, options);
    }
    async destroy(stackName, options = {}) {
        return this.runCommand('npx', ['cdktf', 'destroy', stackName, '--auto-approve'], stackName, options);
    }
    async buildImage(tag, dockerfile, context, options = {}) {
        const dockerfilePath = path_1.default.join(context, 'Dockerfile');
        await promises_1.default.writeFile(dockerfilePath, dockerfile);
        return this.runCommand('docker', ['build', '-t', tag, '.'], tag, { ...options, env: { ...options.env, CD_DIR: context } });
    }
    async importImage(clusterName, imageTag, options = {}) {
        return this.runCommand(path_1.default.join(BIN_DIR, 'k3d'), ['image', 'import', imageTag, '-c', clusterName], imageTag, options);
    }
    async runKubectl(args, kubeconfig) {
        const match = kubeconfig?.match(/\/tmp\/kubeconfig-(.+)$/);
        if (match) {
            const clusterName = match[1];
            const containerName = `k3d-${clusterName}-server-0`;
            const cleanArgs = [];
            for (let i = 0; i < args.length; i++) {
                if (args[i] === '--context') {
                    i++; // skip context name
                }
                else {
                    cleanArgs.push(args[i]);
                }
            }
            const { stdout } = await execAsync(`docker exec ${containerName} kubectl ${cleanArgs.join(' ')}`);
            return stdout;
        }
        const { stdout } = await execAsync(`${path_1.default.join(BIN_DIR, 'kubectl')} ${args.join(' ')}`, {
            env: { ...process.env, KUBECONFIG: kubeconfig || DEFAULT_KUBECONFIG }
        });
        return stdout;
    }
    async runHelm(args, kubeconfig) {
        const match = kubeconfig?.match(/\/tmp\/kubeconfig-(.+)$/);
        if (match) {
            const clusterName = match[1];
            const containerName = `k3d-${clusterName}-server-0`;
            // Ensure helm binary exists in the container
            try {
                await execAsync(`docker exec ${containerName} ls /bin/helm`);
            }
            catch {
                // If not, copy it from host bin/helm
                try {
                    await execAsync(`docker cp ${path_1.default.join(BIN_DIR, 'helm')} ${containerName}:/bin/helm`);
                }
                catch (err) {
                    console.error(`Failed to copy helm to container ${containerName}: ${err.message}`);
                }
            }
            const cleanArgs = [];
            for (let i = 0; i < args.length; i++) {
                if (args[i] === '--kube-context') {
                    i++; // skip context name
                }
                else {
                    cleanArgs.push(args[i]);
                }
            }
            const { stdout } = await execAsync(`docker exec -e KUBECONFIG=/etc/rancher/k3s/k3s.yaml ${containerName} helm ${cleanArgs.join(' ')}`);
            return stdout;
        }
        const { stdout } = await execAsync(`${path_1.default.join(BIN_DIR, 'helm')} ${args.join(' ')}`, {
            env: { ...process.env, KUBECONFIG: kubeconfig || DEFAULT_KUBECONFIG }
        });
        return stdout;
    }
    async getKubeconfig(name) {
        const { stdout } = await execAsync(`${path_1.default.join(BIN_DIR, 'k3d')} kubeconfig get ${name}`);
        return stdout;
    }
    async listLocalClusters() {
        try {
            const { stdout } = await execAsync(`${path_1.default.join(BIN_DIR, 'k3d')} cluster list --no-headers`);
            return stdout
                .split('\n')
                .map(line => line.split(/\s+/)[0])
                .filter(name => !!name);
        }
        catch {
            return [];
        }
    }
    async createLocalCluster(name, options = {}) {
        let resolvConfPath = '/etc/resolv.conf';
        try {
            if ((0, fs_1.existsSync)('/run/systemd/resolve/resolv.conf')) {
                resolvConfPath = '/run/systemd/resolve/resolv.conf';
            }
            else if ((0, fs_1.existsSync)('/var/run/systemd/resolve/resolv.conf')) {
                resolvConfPath = '/var/run/systemd/resolve/resolv.conf';
            }
        }
        catch (e) { }
        const args = [
            'cluster', 'create', name,
            '--network', 'host',
            '--wait',
            '--k3s-arg', `--resolv-conf=${resolvConfPath}@server:*`
        ];
        if (resolvConfPath !== '/etc/resolv.conf') {
            args.push('--volume', `${resolvConfPath}:${resolvConfPath}@server:*`);
        }
        return this.runCommand(path_1.default.join(BIN_DIR, 'k3d'), args, name, {
            ...options,
            env: {
                ...options.env,
                K3D_FIX_DNS: '0'
            }
        });
    }
    async deleteLocalCluster(name, options = {}) {
        return this.runCommand(path_1.default.join(BIN_DIR, 'k3d'), ['cluster', 'delete', name], name, options);
    }
    async streamLogs(resourceId, args, io, room, kubeconfig) {
        this.stopStream(resourceId);
        const match = kubeconfig?.match(/\/tmp\/kubeconfig-(.+)$/);
        let child;
        if (match) {
            const clusterName = match[1];
            const containerName = `k3d-${clusterName}-server-0`;
            const cleanArgs = [];
            for (let i = 0; i < args.length; i++) {
                if (args[i] === '--context') {
                    i++; // skip context name
                }
                else {
                    cleanArgs.push(args[i]);
                }
            }
            child = (0, child_process_1.spawn)('docker', ['exec', '-i', containerName, 'kubectl', ...cleanArgs]);
        }
        else {
            child = (0, child_process_1.spawn)(path_1.default.join(BIN_DIR, 'kubectl'), args, {
                env: { ...process.env, KUBECONFIG: kubeconfig || DEFAULT_KUBECONFIG }
            });
        }
        this.activeStreams.set(resourceId, child);
        child.stdout.on('data', (data) => io.to(room).emit('kube-log', data.toString()));
        child.stderr.on('data', (data) => io.to(room).emit('kube-log', data.toString()));
        child.on('close', () => this.activeStreams.delete(resourceId));
    }
    stopStream(resourceId) {
        const active = this.activeStreams.get(resourceId);
        if (active) {
            active.kill();
            this.activeStreams.delete(resourceId);
        }
    }
    async runCommand(cmd, args, logId, options = {}) {
        const pluginCacheDir = path_1.default.join(os_1.default.homedir(), '.terraform.d/plugin-cache');
        await promises_1.default.mkdir(pluginCacheDir, { recursive: true });
        const env = {
            ...process.env,
            ...options.env,
            PATH: `${process.env.PATH}:${BIN_DIR}`,
            TF_PLUGIN_CACHE_DIR: pluginCacheDir
        };
        const logFile = options.logFile || this.getLogPath(logId);
        const cwd = options.env?.CD_DIR || CDKTF_DIR;
        await promises_1.default.mkdir(LOG_DIR, { recursive: true });
        return new Promise((resolve, reject) => {
            const child = (0, child_process_1.spawn)(cmd, args, { cwd, env });
            let stdout = '', stderr = '';
            const broadcast = (data) => {
                if (options.io && options.resourceId) {
                    options.io.to(options.resourceId).emit('log', data);
                }
            };
            child.stdout.on('data', (data) => {
                const chunk = data.toString();
                stdout += chunk;
                broadcast(chunk);
                promises_1.default.appendFile(logFile, chunk).catch(console.error);
            });
            child.stderr.on('data', (data) => {
                const chunk = data.toString();
                stderr += chunk;
                broadcast(chunk);
                promises_1.default.appendFile(logFile, chunk).catch(console.error);
            });
            child.on('close', (code) => {
                if (code === 0) {
                    resolve({ stdout, logFile });
                }
                else {
                    const errorMsg = `\n--- EXECUTION FAILED (Exit Code ${code}) ---\n`;
                    broadcast(errorMsg);
                    promises_1.default.appendFile(logFile, errorMsg).catch(console.error);
                    reject({ message: `Command failed: ${cmd}`, stdout, stderr, logFile });
                }
            });
            child.on('error', (err) => {
                const errorMsg = `\n--- SPAWN ERROR: ${err.message} ---\n`;
                broadcast(errorMsg);
                reject(err);
            });
        });
    }
}
exports.InfrastructureService = InfrastructureService;
//# sourceMappingURL=InfrastructureService.js.map