"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.provisionClusterActivityMeta = void 0;
exports.ProvisionClusterActivity = ProvisionClusterActivity;
/**
 * ProvisionClusterActivity
 *
 * Performs the physical k3d cluster provisioning: creates the cluster, patches
 * CoreDNS for hostnetwork DNS resolution, patches the local-path StorageClass
 * for volume expansion, and deploys the infrastructure stack (monitoring, agent).
 */
const promises_1 = __importDefault(require("fs/promises"));
const InfrastructureService_js_1 = require("../services/InfrastructureService.js");
exports.provisionClusterActivityMeta = {
    name: 'ProvisionClusterActivity',
    startToCloseTimeout: '80 minutes',
};
async function ProvisionClusterActivity(args) {
    const infra = new InfrastructureService_js_1.InfrastructureService();
    const logFile = args.logFile;
    const kubeconfigPath = `/tmp/kubeconfig-${args.name}`;
    if (args.provider === 'k3d') {
        try {
            infra.runKubectl(['config', 'unset', 'clusters.k3d-' + args.name]);
        }
        catch { }
        await infra.createLocalCluster(args.name, { logFile });
        const kubeconfigContent = await infra.getKubeconfig(args.name);
        await promises_1.default.writeFile(kubeconfigPath, kubeconfigContent, 'utf-8');
        // --- Wait for cluster API server to become responsive ---
        let ready = false;
        for (let i = 0; i < 30; i++) {
            try {
                infra.runKubectl(['get', 'nodes'], kubeconfigPath);
                ready = true;
                break;
            }
            catch { }
            await new Promise((r) => setTimeout(r, 2000));
        }
        if (!ready) {
            throw new Error(`Cluster ${args.name} API server did not become ready in time.`);
        }
        // --- Patch local-path StorageClass to allow volume expansion ---
        let scPatched = false;
        for (let attempt = 0; attempt < 30; attempt++) {
            try {
                await infra.runKubectl([
                    'patch', 'storageclass', 'local-path',
                    '-p', JSON.stringify({ allowVolumeExpansion: true }),
                ], kubeconfigPath);
                scPatched = true;
                break;
            }
            catch {
                await new Promise((r) => setTimeout(r, 2000));
            }
        }
        if (!scPatched) {
            console.warn(`[ProvisionClusterActivity] local-path StorageClass could not be patched`);
        }
        // --- Patch CoreDNS ConfigMap to avoid hostnetwork DNS loop ---
        const dnsList = await getRealNameservers();
        let corednsPatched = false;
        for (let attempt = 0; attempt < 30; attempt++) {
            try {
                const cmJson = await infra.runKubectl(['get', 'configmap', 'coredns', '-n', 'kube-system', '-o', 'json'], kubeconfigPath);
                const cm = JSON.parse(cmJson);
                if (cm?.data?.Corefile) {
                    const updated = cm.data.Corefile.replace(/forward\s+\.\s+\/etc\/resolv\.conf/g, `forward . ${dnsList.join(' ')}`);
                    if (updated !== cm.data.Corefile) {
                        cm.data.Corefile = updated;
                        const containerName = `k3d-${args.name}-server-0`;
                        const cmJsonString = JSON.stringify(cm).replace(/'/g, "'\\''");
                        const exec = (await import('child_process')).exec;
                        await (await import('util')).promisify(exec)(`echo '${cmJsonString}' | docker exec -i ${containerName} kubectl replace -f -`);
                        await infra.runKubectl(['rollout', 'restart', 'deployment/coredns', '-n', 'kube-system'], kubeconfigPath);
                        corednsPatched = true;
                        break;
                    }
                }
            }
            catch {
                await new Promise((r) => setTimeout(r, 2000));
            }
        }
        if (!corednsPatched && !dnsList) {
            console.warn(`[ProvisionClusterActivity] CoreDNS ConfigMap was not available or patched.`);
        }
        // Give it an additional stabilization delay
        await new Promise((r) => setTimeout(r, 5000));
    }
    // 5. Deploy the infrastructure stack (Monitoring, etc.)
    const env = {
        STACK_TYPE: 'cluster',
        ENV: args.provider,
        CLUSTER_NAME: args.name,
        KUBECONFIG_PATH: kubeconfigPath,
    };
    await infra.deploy(args.name, { logFile, env });
    return { status: 'healthy', kubeconfigPath, msg: `Cluster ${args.name} provisioned`, logFile };
}
const PRESETS = ['/run/systemd/resolve/resolv.conf', '/var/run/systemd/resolve/resolv.conf', '/etc/resolv.conf'];
async function getRealNameservers() {
    for (const p of PRESETS) {
        try {
            const lines = await Promise.resolve()
                .then(() => promises_1.default.readFile(p, 'utf-8'))
                .then((c) => c.split('\n'))
                .catch(() => []);
            const ips = lines
                .map((l) => l.trim())
                .flatMap((l) => {
                if (l.startsWith('nameserver '))
                    return l.substring(11).trim().split(/\s+/);
                return [];
            })
                .filter((ip) => ip && !ip.startsWith('127.') && ip !== '::1');
            if (ips.length > 0)
                return ips;
        }
        catch {
            continue;
        }
    }
    return ['8.8.8.8', '1.1.1.1'];
}
//# sourceMappingURL=ProvisionClusterActivity.js.map