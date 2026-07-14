import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { Activity, CheckCircle, XCircle, Loader2, ChevronDown, ChevronUp, Server, Cloud, Shield, Zap, ExternalLink } from 'lucide-react';

const API_BASE = (import.meta.env?.VITE_API_BASE as string) || 'http://localhost:3001/api';

interface ServiceInfo {
  name: string;
  installed: boolean;
  status: string;
  chart: string | null;
  appVersion: string | null;
  namespace: string;
  pods: { name: string; status: string; ip: string | null; ready: boolean }[];
}

const SERVICE_ICONS: Record<string, any> = {
  prometheus: Activity,
  grafana: Zap,
  traefik: Shield,
};

const SERVICE_COLORS: Record<string, string> = {
  prometheus: 'text-amber-500 bg-amber-500/10',
  grafana: 'text-orange-500 bg-orange-500/10',
  traefik: 'text-cyan-500 bg-cyan-500/10',
};

const SERVICE_LABELS: Record<string, string> = {
  prometheus: 'Prometheus Monitoring',
  grafana: 'Grafana Dashboards',
  traefik: 'Traefik Ingress Router',
};

function statusBadge(status: string) {
  const deployed = status === 'deployed';
  return (
    <span className={`inline-flex items-center gap-1.5 text-[10px] font-bold px-3 py-1 rounded-full uppercase ${deployed ? 'bg-green-500/10 text-green-500' : status === 'not-installed' ? 'bg-slate-500/10 text-slate-400' : 'bg-red-500/10 text-red-500'}`}>
      {deployed ? <CheckCircle size={12} /> : status === 'not-installed' ? <XCircle size={12} /> : <XCircle size={12} />}
      {status === 'not-installed' ? 'Not Installed' : status}
    </span>
  );
}

function ServiceCard({ service, clusterId }: { service: ServiceInfo; clusterId: string }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = SERVICE_ICONS[service.name] || Server;
  const color = SERVICE_COLORS[service.name] || 'text-slate-400 bg-slate-500/10';
  const label = SERVICE_LABELS[service.name] || service.name;
  const readyPods = service.pods.filter(p => p.ready).length;
  const dashboardUrl = `${API_BASE}/clusters/${clusterId}/proxy/${service.name}/`;

  return (
    <div className="bg-slate-800 rounded-2xl border border-slate-700 overflow-hidden">
      <div className="p-6">
        <div className="flex justify-between items-start mb-4">
          <div className="flex items-center gap-4">
            <div className={`p-3 rounded-2xl ${color}`}>
              <Icon size={24} />
            </div>
            <div>
              <h4 className="font-bold text-lg">{label}</h4>
              <div className="text-xs text-slate-500 mt-0.5">
                {service.installed ? (
                  <span className="font-mono">{service.chart} v{service.appVersion}</span>
                ) : (
                  <span>Auto-provisioned with cluster</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {service.installed && service.status === 'deployed' && (
              <a
                href={dashboardUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-blue-900/20"
              >
                <ExternalLink size={14} /> Open Dashboard
              </a>
            )}
            {statusBadge(service.status)}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 mt-4">
          <div className="bg-slate-900/50 border border-slate-700/50 p-4 rounded-xl">
            <div className="text-[10px] font-black uppercase text-slate-500 tracking-wider mb-1">Namespace</div>
            <div className="font-mono text-sm text-slate-300">{service.namespace}</div>
          </div>
          <div className="bg-slate-900/50 border border-slate-700/50 p-4 rounded-xl">
            <div className="text-[10px] font-black uppercase text-slate-500 tracking-wider mb-1">Pods Ready</div>
            <div className="font-bold text-sm text-slate-200">
              {service.installed ? (
                <span className={readyPods > 0 ? 'text-green-400' : 'text-red-400'}>
                  {readyPods}/{service.pods.length}
                </span>
              ) : (
                <span className="text-slate-500">--</span>
              )}
            </div>
          </div>
          <div className="bg-slate-900/50 border border-slate-700/50 p-4 rounded-xl">
            <div className="text-[10px] font-black uppercase text-slate-500 tracking-wider mb-1">Version</div>
            <div className="font-mono text-sm text-slate-300">{service.appVersion || '--'}</div>
          </div>
        </div>

        {service.installed && service.pods.length > 0 && (
          <div className="mt-4 pt-4 border-t border-slate-700/50">
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-2 text-xs font-bold text-slate-400 hover:text-white transition-colors uppercase tracking-widest"
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              Pod Details ({service.pods.length})
            </button>
            {expanded && (
              <div className="mt-4 space-y-2 animate-in fade-in slide-in-from-top-2 duration-200">
                {service.pods.map((pod) => (
                  <div key={pod.name} className="flex items-center justify-between p-3 bg-slate-900/50 border border-slate-700/50 rounded-xl">
                    <div className="flex items-center gap-3">
                      <div className={`w-2 h-2 rounded-full ${pod.ready ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]' : 'bg-yellow-500 animate-pulse'}`} />
                      <span className="font-mono text-xs text-slate-300 truncate max-w-[300px]">{pod.name}</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-[10px] font-mono text-slate-500">{pod.ip || '---'}</span>
                      <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${pod.status === 'Running' ? 'bg-green-500/10 text-green-500' : 'bg-yellow-500/10 text-yellow-500'}`}>
                        {pod.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ServicesPanel() {
  const { data: clusters = [] } = useQuery({
    queryKey: ['clusters'],
    queryFn: () => axios.get(`${API_BASE}/clusters`).then(res => res.data),
    refetchInterval: 5000,
  });

  const healthyClusters = clusters.filter((c: any) => c.status === 'healthy');
  const [selectedCluster, setSelectedCluster] = useState<string | null>(null);

  const effectiveClusterId = selectedCluster || healthyClusters[0]?.id;

  const { data: servicesData, isLoading } = useQuery({
    queryKey: ['cluster-services', effectiveClusterId],
    queryFn: () => axios.get(`${API_BASE}/clusters/${effectiveClusterId}/services`).then(r => r.data),
    enabled: !!effectiveClusterId,
    refetchInterval: 10000,
  });

  const services: ServiceInfo[] = servicesData?.services || [];
  const selectedClusterName = healthyClusters.find((c: any) => c.id === effectiveClusterId)?.name || 'Unknown';

  return (
    <section className="animate-in fade-in slide-in-from-bottom-4 duration-300 max-w-6xl">
      <header className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-3xl font-bold">Cluster Services</h2>
          <p className="text-slate-400">Auto-provisioned infrastructure services on your clusters.</p>
        </div>
        <div className="flex items-center gap-3">
          {healthyClusters.length > 0 && (
            <select
              value={effectiveClusterId || ''}
              onChange={e => setSelectedCluster(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-2 text-sm text-slate-300 focus:border-blue-500 transition-all"
            >
              {healthyClusters.map((c: any) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}
          <div className="flex items-center gap-2 px-4 py-2 bg-slate-800 rounded-xl text-xs text-slate-400">
            <Cloud size={14} /> {selectedClusterName}
          </div>
        </div>
      </header>

      {healthyClusters.length === 0 ? (
        <div className="bg-slate-800 rounded-2xl border border-slate-700 p-16 text-center">
          <Cloud size={48} className="mx-auto mb-4 text-slate-600 opacity-30" />
          <h3 className="text-lg font-bold text-slate-300 mb-2">No Healthy Clusters</h3>
          <p className="text-sm text-slate-500">Provision a cluster to auto-deploy Prometheus, Grafana, and Traefik.</p>
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="animate-spin text-slate-600" size={32} />
        </div>
      ) : (
        <div className="space-y-6">
          {services.map(service => (
            <ServiceCard key={service.name} service={service} clusterId={effectiveClusterId!} />
          ))}
        </div>
      )}
    </section>
  );
}
