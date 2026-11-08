import React from 'react';
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

export interface ShellContext {
  clusters: Cluster[];
  deployments: Deployment[];
  providers: ProviderStatus[];
  setShowAppModal: (show: boolean) => void;
  openDashboard: (type: 'cluster' | 'app', id: string) => void;
}

export const ShellContextInstance = React.createContext<ShellContext | null>(null);
export const useShellContext = () => React.useContext(ShellContextInstance);
