import { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release/index.js";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
function resolveBitnamiImage(inputRepo, defaultRepo) {
    const repo = inputRepo || defaultRepo;
    if (repo.includes('/') && repo.split('/')[0].includes('.')) {
        const parts = repo.split('/');
        const registry = parts[0];
        const repository = parts.slice(1).join('/');
        return { registry, repository };
    }
    return {
        registry: "docker.io",
        repository: (repo.startsWith('bitnami/') || repo.startsWith('bitnamilegacy/')) ? repo : `bitnami/${repo}`
    };
}
export class WordPressApp extends Construct {
    constructor(scope, id, config = {}) {
        super(scope, id);
        const namespaceName = config.namespace || "wordpress";
        const web = resolveBitnamiImage(config.webRepo || "", "bitnami/wordpress");
        const db = resolveBitnamiImage(config.dbRepo || "", "bitnami/mariadb");
        const ns = new Namespace(this, "ns", {
            metadata: {
                name: namespaceName,
            },
        });
        const serviceType = config.serviceType || (process.env.KUBECONFIG_CONTEXT?.startsWith("k3d-") ? "NodePort" : "LoadBalancer");
        const helmValues = [
            { name: "service.type", value: serviceType },
            { name: "global.security.allowInsecureImages", value: true },
            // WordPress Web Image
            { name: "image.registry", value: web.registry },
            { name: "image.repository", value: web.repository },
            { name: "image.tag", value: config.webTag || "6.7.1-debian-12-r0" },
            // MariaDB DB Image
            { name: "mariadb.image.registry", value: db.registry },
            { name: "mariadb.image.repository", value: db.repository },
            { name: "mariadb.image.tag", value: config.dbTag || "11.4.5-debian-12-r1" }
        ];
        if (config.dbStorage) {
            helmValues.push({ name: "mariadb.primary.persistence.size", value: config.dbStorage });
        }
        if (config.webStorage) {
            helmValues.push({ name: "persistence.size", value: config.webStorage });
        }
        new Release(this, "wordpress-release", {
            name: "wordpress",
            chart: "oci://registry-1.docker.io/bitnamicharts/wordpress",
            namespace: ns.metadata.name,
            timeout: 600,
            set: helmValues,
        });
    }
}
