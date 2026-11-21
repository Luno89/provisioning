import { webUrl, withDatabase } from './dev-split.js';

export const DEV = {
  rootDatabase: 'koala_dev_root',
  rootHost: 'koala',
  rootApiPort: 3002,
  rootWebPort: 5175,
  instanceName: 'dev',
  instanceWebPort: 5173,
  instanceNodePort: 30320,
  giteaNodePort: 31737,
  meshLoginServer: 'http://127.0.0.1:8080',
  headscale: 'http://127.0.0.1:8080',
  mongo: 'mongodb://admin:admin@localhost:27017/provisioning?authSource=admin',
  temporal: '127.0.0.1:7233',
  temporalNamespace: 'default',
  rootWorkerMetricsPort: 9465,
  mailFrom: 'koala@koala.localhost',
  registry: '127.0.0.1:5001',
  registryPush: '127.0.0.1:5000',
  imageTag: 'dev',
  podGateway: '10.42.0.1',
  ownerEmail: 'dev@koala.localhost',
} as const;

export const devGiteaOnThisComputer = `http://127.0.0.1:${DEV.giteaNodePort}`;

export interface DevRootInput {
  mongoUri: string;
  setupCode: string;
  temporalCa: string;
  dataDir: string;
}

export interface DevRootPlan {
  rootUrl: string;
  instanceUrl: string;
  rootEnv: Record<string, string>;
}

const devTemporal = (input: Pick<DevRootInput, 'temporalCa' | 'dataDir'>): Record<string, string> => ({
  TEMPORAL_CONNECTION_ADDRESS: DEV.temporal,
  TEMPORAL_NAMESPACE: DEV.temporalNamespace,
  TEMPORAL_TLS_CA: input.temporalCa,
  DATA_DIR: input.dataDir,
});

export function devRootPlan(input: DevRootInput): DevRootPlan {
  const rootUrl = webUrl(DEV.rootHost, DEV.rootWebPort);
  return {
    rootUrl,
    instanceUrl: webUrl(DEV.instanceName, DEV.instanceWebPort),
    rootEnv: {
      ROLE: 'root',
      PORT: String(DEV.rootApiPort),
      MONGO_URI: withDatabase(input.mongoUri, DEV.rootDatabase),
      PUBLIC_URL: rootUrl,
      APP_URL: rootUrl,
      ADMIN_SETUP_CODE: input.setupCode,
      MESH_LOGIN_SERVER: DEV.meshLoginServer,
      INSTANCE_REGISTRY: DEV.registry,
      INSTANCE_IMAGE_TAG: DEV.imageTag,
      SIGN_IN_RETURN_URL: `http://localhost:${DEV.rootWebPort}`,
      KOALA_TELEMETRY_CLUSTER: 'root',
      ...devTemporal(input),
      TERRAFORM_STATE: 'local',
      HEADSCALE_URL: DEV.headscale,
      MAIL_FROM: DEV.mailFrom,
      HEALTH_PORT: '0',
      TEMPORAL_METRICS_PORT: String(DEV.rootWorkerMetricsPort),
    },
  };
}

export function devKoalaValues(checkout: string, instanceUrl: string): string {
  return [
    `publicUrl: "${instanceUrl}"`,
    'image:',
    '  pullPolicy: Always',
    'dev:',
    `  source: "${checkout}"`,
    'hostAliases:',
    `  - ip: "${DEV.podGateway}"`,
    '    hostnames:',
    `      - "${DEV.rootHost}.localhost"`,
    '',
  ].join('\n');
}
