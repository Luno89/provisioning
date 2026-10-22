import React from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import { Cloud, Network, Settings } from 'lucide-react';
import type { Cluster } from '../types/cluster';
import type { Deployment } from '../types/deployment';
import type { ProviderStatus } from '../types/credentials';

export const SIDEBAR_PAGES = [
  { id: 'mesh' as const, label: 'My Machines', icon: Network },
  { id: 'accounts' as const, label: 'Cloud providers', icon: Cloud },
  { id: 'settings' as const, label: 'Settings', icon: Settings },
];

export type SidebarPage = (typeof SIDEBAR_PAGES)[number];

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
