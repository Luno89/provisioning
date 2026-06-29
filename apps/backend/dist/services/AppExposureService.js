"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppExposureService = void 0;
const BaseService_js_1 = require("./BaseService.js");
const child_process_1 = require("child_process");
const util_1 = require("util");
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const url_1 = require("url");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
const __filename = (0, url_1.fileURLToPath)(import.meta.url);
const __dirname = path_1.default.dirname(__filename);
class AppExposureService extends BaseService_js_1.BaseService {
    infra;
    clusters;
    nginxConfDir;
    constructor(db, infra, clusters) {
        super(db);
        this.infra = infra;
        this.clusters = clusters;
        this.nginxConfDir = path_1.default.join(__dirname, '../../data/nginx');
    }
    sanitize(name) {
        return name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    }
    async buildUpstreamTarget(dep, cluster) {
        const namespace = this.sanitize(dep.name);
        const kubeconfigPath = await this.clusters.getKubeconfigPath(cluster);
        const output = await this.infra.runKubectl(['get', 'svc', '-n', namespace, '-o', 'json'], kubeconfigPath);
        const res = JSON.parse(output);
        const services = res.items || [];
        const dbKeywords = ['db', 'postgres', 'mysql', 'redis', 'mongo', 'memcached', 'mariadb', 'influx', 'cassandra', 'elasticsearch'];
        const dbPorts = [5432, 3306, 6379, 27017, 11211, 8086, 9042, 9200];
        const candidateServices = services.filter((svc) => {
            const name = svc.metadata?.name?.toLowerCase() || '';
            if (dbKeywords.some(kw => name.includes(kw)))
                return false;
            const ports = svc.spec?.ports || [];
            if (ports.length === 0)
                return false;
            return ports.some((p) => !dbPorts.includes(p.port));
        });
        if (candidateServices.length === 0) {
            throw new Error(`No proxyable web services found in namespace "${namespace}".`);
        }
        const primarySvc = candidateServices.find((svc) => svc.spec?.type === 'LoadBalancer' || svc.spec?.type === 'NodePort') || candidateServices[0];
        const svcName = primarySvc.metadata.name;
        const portObj = primarySvc.spec?.ports?.find((p) => !dbPorts.includes(p.port)) || primarySvc.spec?.ports?.[0];
        const targetPort = portObj?.port || 80;
        let backendTarget = '';
        if (cluster.provider === 'k3d') {
            const nodePort = portObj?.nodePort;
            if (!nodePort) {
                throw new Error(`Service "${svcName}" does not have a nodePort assigned. Cannot expose locally.`);
            }
            backendTarget = `172.17.0.1:${nodePort}`;
        }
        else {
            const ingress = primarySvc.status?.loadBalancer?.ingress?.[0];
            const targetIpOrHost = ingress?.ip || ingress?.hostname;
            if (!targetIpOrHost) {
                throw new Error(`Cloud LoadBalancer for service "${svcName}" is still provisioning.`);
            }
            backendTarget = `${targetIpOrHost}:${targetPort}`;
        }
        return { namespace, backendTarget };
    }
    buildConfContent(namespace, backendTarget) {
        return `server {
    listen 80;
    server_name ${namespace} ~^${namespace}\\..*$;

    location / {
        resolver 127.0.0.11 valid=10s;
        set \$upstream "${backendTarget}";
        proxy_pass http://\$upstream;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSockets / longpolling settings
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
`;
    }
    async expose(id) {
        const deployments = await this.db.getDeployments();
        const dep = deployments.find(d => d.id === id);
        if (!dep)
            throw new Error('Deployment not found');
        const cluster = await this.clusters.getById(dep.clusterId);
        if (!cluster)
            throw new Error('Cluster not found');
        const { namespace, backendTarget } = await this.buildUpstreamTarget(dep, cluster);
        const confPath = path_1.default.join(this.nginxConfDir, 'conf.d', `${namespace}.conf`);
        const confContent = this.buildConfContent(namespace, backendTarget);
        await promises_1.default.mkdir(path_1.default.dirname(confPath), { recursive: true });
        await promises_1.default.writeFile(confPath, confContent);
        try {
            await execAsync('docker exec provisioner-nginx nginx -s reload');
        }
        catch (err) {
            throw new Error(`Failed to reload Nginx container: ${err.message}`);
        }
        const exposureUrl = `http://${namespace}.localhost:8000`;
        dep.isExposed = true;
        dep.exposureUrl = exposureUrl;
        await this.db.saveDeployment(dep);
        return dep;
    }
    async syncExposedApps() {
        const deployments = await this.db.getDeployments();
        const exposed = deployments.filter(d => d.isExposed);
        let changed = false;
        for (const dep of exposed) {
            try {
                const cluster = await this.clusters.getById(dep.clusterId);
                if (!cluster) {
                    this.logger.warn(`Cluster not found for deployment "${dep.name}", skipping sync`);
                    continue;
                }
                const { namespace, backendTarget } = await this.buildUpstreamTarget(dep, cluster);
                const confPath = path_1.default.join(this.nginxConfDir, 'conf.d', `${namespace}.conf`);
                const confContent = this.buildConfContent(namespace, backendTarget);
                await promises_1.default.mkdir(path_1.default.dirname(confPath), { recursive: true });
                await promises_1.default.writeFile(confPath, confContent);
                changed = true;
                this.logger.info(`Synced nginx config for "${dep.name}" -> ${backendTarget}`);
            }
            catch (err) {
                this.logger.error(`Failed to sync nginx config for "${dep.name}": ${err.message}`);
            }
        }
        // Remove conf.d files for deployments that are no longer exposed or no longer exist
        const exposedNamespaces = new Set(exposed.map(d => this.sanitize(d.name)));
        const confDir = path_1.default.join(this.nginxConfDir, 'conf.d');
        try {
            const files = await promises_1.default.readdir(confDir);
            for (const file of files) {
                if (file === 'default.conf')
                    continue;
                const ns = file.replace(/\.conf$/, '');
                if (!exposedNamespaces.has(ns)) {
                    await promises_1.default.unlink(path_1.default.join(confDir, file));
                    this.logger.info(`Removed stale nginx config: ${file}`);
                    changed = true;
                }
            }
        }
        catch (err) {
            this.logger.error(`Failed to clean stale nginx configs: ${err.message}`);
        }
        if (changed) {
            try {
                await execAsync('docker exec provisioner-nginx nginx -s reload');
                this.logger.info('Nginx reloaded after sync');
            }
            catch (err) {
                this.logger.error(`Failed to reload Nginx after sync: ${err.message}`);
            }
        }
    }
    async unexpose(id) {
        const deployments = await this.db.getDeployments();
        const dep = deployments.find(d => d.id === id);
        if (!dep)
            throw new Error('Deployment not found');
        const namespace = this.sanitize(dep.name);
        // 1. Remove Nginx configuration file
        const confPath = path_1.default.join(this.nginxConfDir, 'conf.d', `${namespace}.conf`);
        try {
            await promises_1.default.unlink(confPath);
        }
        catch (err) {
            // Ignore if file doesn't exist
        }
        // 2. Reload Nginx
        try {
            await execAsync('docker exec provisioner-nginx nginx -s reload');
        }
        catch (err) {
            this.logger.error(`Failed to reload Nginx container: ${err.message}`);
        }
        // 4. Update metadata
        dep.isExposed = false;
        delete dep.exposureUrl;
        await this.db.saveDeployment(dep);
        return dep;
    }
}
exports.AppExposureService = AppExposureService;
//# sourceMappingURL=AppExposureService.js.map