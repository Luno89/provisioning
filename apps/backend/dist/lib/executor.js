"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Executor = void 0;
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const promises_1 = __importDefault(require("fs/promises"));
const util_1 = require("util");
const url_1 = require("url");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
const __filename = (0, url_1.fileURLToPath)(import.meta.url);
const __dirname = path_1.default.dirname(__filename);
const CDKTF_DIR = path_1.default.join(__dirname, '../../../../packages/cdktf-infra');
const LOG_DIR = path_1.default.join(__dirname, '../../data/logs');
const BIN_DIR = '/home/luno/Code/provisioning/bin';
class Executor {
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
    async createLocalCluster(name, options = {}) {
        return this.runCommand(path_1.default.join(BIN_DIR, 'k3d'), ['cluster', 'create', name, '--wait', '-p', '8069:8069@loadbalancer'], name, options);
    }
    async deleteLocalCluster(name, options = {}) {
        return this.runCommand(path_1.default.join(BIN_DIR, 'k3d'), ['cluster', 'delete', name], name, options);
    }
    async listHelmReleases(kubeconfig, context) {
        const contextFlag = context ? `--kube-context ${context}` : '';
        const { stdout } = await execAsync(`${path_1.default.join(BIN_DIR, 'helm')} list -A ${contextFlag} -o json`, {
            env: { ...process.env, KUBECONFIG: kubeconfig }
        });
        return JSON.parse(stdout);
    }
    async getHelmStatus(kubeconfig, releaseName, namespace, context) {
        const contextFlag = context ? `--kube-context ${context}` : '';
        const { stdout } = await execAsync(`${path_1.default.join(BIN_DIR, 'helm')} status ${releaseName} -n ${namespace} ${contextFlag}`, {
            env: { ...process.env, KUBECONFIG: kubeconfig }
        });
        return stdout;
    }
    async getDiagnostics(kubeconfig, namespace, context) {
        const contextFlag = context ? `--context ${context}` : '';
        const { stdout: events } = await execAsync(`${path_1.default.join(BIN_DIR, 'kubectl')} get events -n ${namespace} ${contextFlag} --sort-by='.lastTimestamp' -o wide`, {
            env: { ...process.env, KUBECONFIG: kubeconfig }
        });
        const { stdout: pods } = await execAsync(`${path_1.default.join(BIN_DIR, 'kubectl')} get pods -n ${namespace} ${contextFlag} -o wide`, {
            env: { ...process.env, KUBECONFIG: kubeconfig }
        });
        return `--- POD STATUS ---\n${pods}\n\n--- RECENT EVENTS ---\n${events}`;
    }
    async listPods(kubeconfig, namespace, context) {
        const nsFlag = namespace === '--all-namespaces' ? '--all-namespaces' : `-n ${namespace || 'default'}`;
        const contextFlag = context ? `--context ${context}` : '';
        const command = `${path_1.default.join(BIN_DIR, 'kubectl')} get pods ${nsFlag} ${contextFlag} -o json`;
        const { stdout } = await execAsync(command, {
            env: { ...process.env, KUBECONFIG: kubeconfig }
        });
        return JSON.parse(stdout).items;
    }
    async streamPodLogs(resourceId, namespace, podName, io, context) {
        this.stopKubeStream(resourceId);
        const args = ['logs', '-n', namespace, podName, '--tail=100', '-f'];
        if (context)
            args.push('--context', context);
        const child = (0, child_process_1.spawn)(path_1.default.join(BIN_DIR, 'kubectl'), args, {
            env: { ...process.env, KUBECONFIG: '/home/luno/.kube/config' }
        });
        this.activeStreams.set(resourceId, child);
        child.stdout.on('data', (data) => io.to(`${resourceId}-kube`).emit('kube-log', data.toString()));
        child.stderr.on('data', (data) => io.to(`${resourceId}-kube`).emit('kube-log', data.toString()));
        child.on('close', () => this.activeStreams.delete(resourceId));
    }
    stopKubeStream(resourceId) {
        const active = this.activeStreams.get(resourceId);
        if (active) {
            active.kill();
            this.activeStreams.delete(resourceId);
        }
    }
    async runCommand(cmd, args, logId, options = {}) {
        const env = { ...process.env, ...options.env, PATH: `${process.env.PATH}:${BIN_DIR}` };
        const logFile = options.logFile || this.getLogPath(logId);
        await promises_1.default.mkdir(LOG_DIR, { recursive: true });
        return new Promise((resolve, reject) => {
            const child = (0, child_process_1.spawn)(cmd, args, { cwd: CDKTF_DIR, env });
            let stdout = '', stderr = '';
            child.stdout.on('data', (data) => {
                const chunk = data.toString();
                stdout += chunk;
                if (options.io && options.resourceId)
                    options.io.to(options.resourceId).emit('log', chunk);
                promises_1.default.appendFile(logFile, chunk).catch(console.error);
            });
            child.stderr.on('data', (data) => {
                const chunk = data.toString();
                stderr += chunk;
                if (options.io && options.resourceId)
                    options.io.to(options.resourceId).emit('log', chunk);
                promises_1.default.appendFile(logFile, chunk).catch(console.error);
            });
            child.on('close', (code) => {
                const result = { stdout, stderr, logFile };
                code === 0 ? resolve(result) : reject({ message: `Command failed: ${cmd}`, ...result });
            });
            child.on('error', reject);
        });
    }
}
exports.Executor = Executor;
//# sourceMappingURL=executor.js.map