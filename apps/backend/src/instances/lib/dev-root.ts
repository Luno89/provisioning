import { webUrl, withDatabase } from './dev-split.js';

export const DEV = {
  rootDatabase: 'koala_dev_root',
  rootHost: 'koala',
  rootApiPort: 3002,
  rootWebPort: 5175,
  hubDatabase: 'koala_dev_hub',
  hubHost: 'hub',
  hubApiPort: 3003,
  hubWebPort: 5176,
  instanceName: 'dev',
  instanceWebPort: 5173,
  instanceNodePort: 30320,
  giteaNodePort: 31737,
  meshLoginServer: 'http://127.0.0.1:8080',
  registry: '127.0.0.1:5001',
  registryPush: '127.0.0.1:5000',
  imageTag: 'dev',
  podGateway: '10.42.0.1',
  ownerEmail: 'dev@koala.localhost',
} as const;

export const devGiteaOnThisComputer = `http://127.0.0.1:${DEV.giteaNodePort}`;

export const devHubOnThePodNetwork = `http://${DEV.podGateway}:${DEV.hubApiPort}`;

export interface DevRootInput {
  mongoUri: string;
  setupCode: string;
  hubCredential: string;
  hubCredentialHash: string;
  rootPublicKeys: string;
}

export interface DevRootPlan {
  rootUrl: string;
  hubUrl: string;
  instanceUrl: string;
  rootEnv: Record<string, string>;
  hubEnv: Record<string, string>;
}

export function devRootPlan(input: DevRootInput): DevRootPlan {
  const rootUrl = webUrl(DEV.rootHost, DEV.rootWebPort);
  const hubUrl = webUrl(DEV.hubHost, DEV.hubWebPort);
  const rootPublicKeys = Buffer.from(input.rootPublicKeys, 'utf8').toString('base64');
  return {
    rootUrl,
    hubUrl,
    instanceUrl: webUrl(DEV.instanceName, DEV.instanceWebPort),
    rootEnv: {
      ROLE: 'root',
      PORT: String(DEV.rootApiPort),
      MONGO_URI: withDatabase(input.mongoUri, DEV.rootDatabase),
      PUBLIC_URL: rootUrl,
      APP_URL: rootUrl,
      HUB_URL: hubUrl,
      HUB_CREDENTIAL_HASH: input.hubCredentialHash,
      ADMIN_SETUP_CODE: input.setupCode,
      MESH_LOGIN_SERVER: DEV.meshLoginServer,
      INSTANCE_REGISTRY: DEV.registry,
      INSTANCE_IMAGE_TAG: DEV.imageTag,
      SIGN_IN_RETURN_URL: `http://localhost:${DEV.rootWebPort}`,
      KOALA_TELEMETRY_CLUSTER: 'root',
    },
    hubEnv: {
      ROLE: 'hub',
      PORT: String(DEV.hubApiPort),
      MONGO_URI: withDatabase(input.mongoUri, DEV.hubDatabase),
      HUB_DATABASE: DEV.hubDatabase,
      PUBLIC_URL: hubUrl,
      APP_URL: hubUrl,
      ROOT_URL: rootUrl,
      ROOT_PUBLIC_KEYS: rootPublicKeys,
      HUB_CREDENTIAL: input.hubCredential,
      GITEA_URL: devGiteaOnThisComputer,
      GITEA_REACHES_KOALA_AT: devHubOnThePodNetwork,
      KOALA_TELEMETRY_CLUSTER: 'hub',
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
    `      - "${DEV.hubHost}.localhost"`,
    '',
  ].join('\n');
}
