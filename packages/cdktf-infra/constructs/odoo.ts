import { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release/index.js";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";

export interface OdooConfig {
  readonly namespace?: string;
  readonly odooRepo?: string;
  readonly odooTag?: string;
  readonly pgRepo?: string;
  readonly pgTag?: string;
  readonly dbStorage?: string;
  readonly webStorage?: string;
  readonly serviceType?: string;
}

/**
 * Resolves an image into the format Bitnami charts expect.
 * Ensures the registry and repository are split correctly.
 */
function resolveBitnamiImage(inputRepo: string, defaultRepo: string) {
  const repo = inputRepo || defaultRepo;
  
  // If the user provided a full URI (e.g. public.ecr.aws/bitnami/odoo)
  if (repo.includes('/') && repo.split('/')[0].includes('.')) {
    const parts = repo.split('/');
    const registry = parts[0];
    const repository = parts.slice(1).join('/');
    return { registry, repository };
  }

  // Default to Docker Hub but ensure correct namespacing
  return {
    registry: "docker.io",
    repository: (repo.startsWith('bitnami/') || repo.startsWith('bitnamilegacy/')) ? repo : `bitnami/${repo}`
  };
}

export class OdooApp extends Construct {
  constructor(scope: Construct, id: string, config: OdooConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "odoo";
    const odoo = resolveBitnamiImage(config.odooRepo || "", "bitnami/odoo");
    const pg = resolveBitnamiImage(config.pgRepo || "", "bitnami/postgresql");

    const ns = new Namespace(this, "ns", {
      metadata: {
        name: namespaceName,
      },
    });

    const serviceType = config.serviceType || (process.env.KUBECONFIG_CONTEXT?.startsWith("k3d-") ? "NodePort" : "LoadBalancer");

    const helmValues: any[] = [
      { name: "service.type", value: serviceType },
      { name: "global.security.allowInsecureImages", value: true },
      
      // Odoo Image
      { name: "image.registry", value: odoo.registry },
      { name: "image.repository", value: odoo.repository },
      { name: "image.tag", value: config.odooTag || "18.0.20250805-debian-12-r8" },

      // PostgreSQL Image
      { name: "postgresql.image.registry", value: pg.registry },
      { name: "postgresql.image.repository", value: pg.repository },
      { name: "postgresql.image.tag", value: config.pgTag || "17.5.0-debian-12-r20" }
    ];

    if (config.dbStorage) {
      helmValues.push({ name: "postgresql.primary.persistence.size", value: config.dbStorage });
    }
    if (config.webStorage) {
      helmValues.push({ name: "persistence.size", value: config.webStorage });
    }

    new Release(this, "odoo-release", {
      name: "odoo",
      chart: "oci://registry-1.docker.io/bitnamicharts/odoo",
      namespace: ns.metadata.name,
      timeout: 600,
      set: helmValues,
    });
  }
}
