import React from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import { Activity, Cloud, Key, Network, Package, Puzzle, Server, Shield, Timer } from 'lucide-react';
import type { Cluster } from '../types/cluster';
import type { Deployment } from '../types/deployment';
import type { ProviderStatus } from '../types/credentials';

export const FOREST_TABS = [
  { id: 'clusters' as const, label: 'Clusters', icon: Cloud },
  { id: 'apps' as const, label: 'Applications', icon: Server },
  { id: 'vps-catalog' as const, label: 'VPS Catalog', icon: Package },
  { id: 'mesh' as const, label: 'My Machines', icon: Network },
  { id: 'accounts' as const, label: 'Cloud Accounts', icon: Key },
  { id: 'services' as const, label: 'Services', icon: Activity },
  { id: 'nginx' as const, label: 'Nginx Router', icon: Puzzle },
  { id: 'temporal' as const, label: 'Temporal', icon: Timer },
  { id: 'settings' as const, label: 'Security', icon: Shield },
];

export type ForestTab = (typeof FOREST_TABS)[number];

export interface WizardPreset {
  provider: string;
  serverType?: string;
  location?: string;
}

export interface ShellContext {
  clusters: Cluster[];
  deployments: Deployment[];
  providers: ProviderStatus[];
  setShowClusterModal: (show: boolean) => void;
  setShowAppModal: (show: boolean) => void;
  setWizardPreset: (preset: WizardPreset | undefined) => void;
  openDashboard: (type: 'cluster' | 'app', id: string) => void;
  editorContent: string;
  setEditorContent: React.Dispatch<React.SetStateAction<string>>;
  loadingNginxConfig: boolean;
  updateNginxConfig: UseMutationResult<void, unknown, string>;
  vpnDomains: Record<string, string>;
  setVpnDomains: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setShowNginxWizard: (show: boolean) => void;
}

export const ShellContextInstance = React.createContext<ShellContext | null>(null);
export const useShellContext = () => React.useContext(ShellContextInstance);
