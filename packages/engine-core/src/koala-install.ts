import type { ProgressContract } from './machine-progress.js';

export const KOALA_INSTALL_STAGES = ['cluster', 'chart', 'koala'] as const;

export type KoalaInstallStage = (typeof KOALA_INSTALL_STAGES)[number];

export const KOALA_INSTALL_LAST_STAGE: KoalaInstallStage = 'koala';

export const KOALA_INSTALL_PROGRESS: ProgressContract = { lines: true, lastStage: KOALA_INSTALL_LAST_STAGE };

export const KOALA_INSTALL_ROUTE = '/koala-installs/:installId/progress';

export const koalaInstallProgressPath = (installId: string): string => `/api/machines/koala-installs/${encodeURIComponent(installId)}/progress`;

export const PLACE_KOALA = 'machine:place-koala';

export const KOALA_INSTALL_CHANGED = 'koala-install-changed';

export const KOALA_INSTALL_STATES = ['asked', 'installing', 'ready', 'failed'] as const;

export type KoalaInstallState = (typeof KOALA_INSTALL_STATES)[number];

export interface PlacedKoala {
  installId: string;
  instanceId: string;
  ownerId: string;
  machineId: string;
  rootUrl: string;
  rootPublicKeys: string;
  meshLoginServer: string;
  meshAddress: string;
  image: string;
  imageTag: string;
  imageDigest?: string | undefined;
  chartUrl: string;
  chartSha256?: string | undefined;
  credential: string;
  name: string;
  domain: string;
}

export interface KoalaInstallView {
  id: string;
  machineId: string;
  state: KoalaInstallState;
  stage?: string;
  title?: string;
  line?: string;
  why?: string;
  at: string;
}
