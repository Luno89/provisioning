import type { AppType } from './app-types';

/**
 * What the deploy wizard starts from, and what "Deploy Application" resets it to.
 *
 * ── WHY IT IS A MODULE CONSTANT ──
 * Forty-four keys, written out TWICE: once as App's `useState` initialiser and once inline in an
 * `onClick` in `AppsView.tsx`, which is the button that opens the wizard. Two hand-maintained
 * copies of the same object, in different files, and nothing to make them agree — a field added to
 * one is simply missing when the wizard is opened the other way, and the wizard shows a stale value
 * from the previous deploy.
 *
 * `as const` is deliberately NOT used: the wizard mutates this shape field by field, so the values
 * need to stay writable and widely typed.
 */
export const EMPTY_WIZARD_DATA = {
  name: 'Odoo-Production',
  clusterId: '',
  appType: 'odoo' as AppType,
  strategy: 'native' as 'helm' | 'native',
  odooRepo: 'library/odoo',
  odooTag: '18.0',
  pgRepo: 'library/postgres',
  pgTag: '16.4',
  modules: [] as string[],
  vpnEnabled: false,
  vpnProtocol: 'wireguard' as 'wireguard' | 'openvpn',
  vpnConfig: '',
  vpnDedicatedIp: '',
  vllmMaxModelLen: '',
  vllmGpuMemUtil: '',
  vllmExtraArgs: '',
  vllmToolCallingEnabled: false,
  vllmToolCallParser: '',
  vllmServedModelName: '',
  vllmMaxNumSeqs: '',
  vllmDtype: '',
  vllmEnablePrefixCaching: false,
  tabbyModel: 'turboderp/Qwen3.6-27B-exl3',
  tabbyRevision: '',
  tabbyGpuCount: '2',
  tabbyHfToken: '',
  tabbyImageTag: 'latest',
  tabbyCacheMode: 'Q8',
  tabbyMaxSeqLen: '32768',
  tabbyMaxBatchSize: '',
  tabbyReasoning: true,
  tabbyToolFormat: 'qwen3_coder',
  tabbyInlineModelLoading: false,
  tabbyDisableAuth: true,
  tabbyMemoryLimit: '',
  tabbyShmSize: '',
  tabbyCpuLimit: '10',
  tabbyExtraEnv: '',
  openWebuiTargetId: '',
  hermesTargetId: '',
  webuiEnableWebSearch: true,
  webuiWebSearchEngine: 'duckduckgo',
  webuiWebSearchApiKey: '',
  palworldPlayers: '16'
  };

/** The shape the wizard edits. Derived, so a new default is a new field without restating it. */
export type WizardData = typeof EMPTY_WIZARD_DATA;
