import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Package, Shield, X } from 'lucide-react';
import { insertServerBlock } from '../lib/nginx-config';
import type { Cluster } from '../types/cluster';
import type { Deployment } from '../types/deployment';

export interface NginxWizardProps {
  clusters: Cluster[];
  deployments: Deployment[];
  onClose: () => void;
  onAppend: (update: (current: string) => string) => void;
}

export default function NginxWizard({ clusters, deployments, onClose, onAppend }: NginxWizardProps) {
  const [nginxWizardStep, setNginxWizardStep] = useState(1);
  const [nginxWizardData, setNginxWizardData] = useState<Record<string, string>>({});
  const setShowNginxWizard = (open: boolean) => { if (!open) onClose(); };
  return (

    <div className="fixed inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center p-4 z-50">
      <div className="bg-slate-800 border border-slate-700 rounded-3xl p-10 w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex justify-between items-center mb-8">
          <h3 className="text-2xl font-bold">Proxy Exposure Wizard</h3>
          <div className="flex items-center gap-4">
            <div className="flex gap-2">
              {[1, 2, 3].map(s => (
                <div key={s} className={`w-8 h-1.5 rounded-full transition-all ${nginxWizardStep >= s ? 'bg-blue-500' : 'bg-slate-700'}`}></div>
              ))}
            </div>
            <button onClick={() => setShowNginxWizard(false)} className="text-slate-400 hover:text-white transition-colors" aria-label="Close Wizard">
              <X size={24} />
            </button>
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
          {nginxWizardStep === 1 && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10">
                <h4 className="font-bold flex items-center gap-2 mb-2"><Package className="text-blue-500" size={18}/> Select Application</h4>
                <p className="text-slate-400 text-sm">Choose the deployment instance you wish to expose over Nginx.</p>
              </div>
              <div>
                <label htmlFor="nginx-wizard-app" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Application Instance</label>
                <select
                  id="nginx-wizard-app"
                  value={nginxWizardData.deploymentId}
                  onChange={e => {
                    const dep = deployments.find((d) => d.id === e.target.value);
                    setNginxWizardData(prev => ({
                      ...prev,
                      deploymentId: e.target.value,
                      domain: dep ? `${dep.name.toLowerCase()}.vpn.local` : ''
                    }));
                  }}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all text-slate-100"
                >
                  <option value="">Select an application...</option>
                  {deployments.map((d) => {
                    const cluster = clusters.find((c) => c.id === d.clusterId);
                    return (
                      <option key={d.id} value={d.id}>
                        {d.name} ({d.appType}) on {cluster ? cluster.name : 'Unknown'}
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>
          )}

          {nginxWizardStep === 2 && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="p-6 bg-blue-500/5 rounded-2xl border border-blue-500/10">
                <h4 className="font-bold flex items-center gap-2 mb-2"><Shield className="text-blue-500" size={18}/> Domain & Traffic Settings</h4>
                <p className="text-slate-400 text-sm">Configure the hostname and transfer settings for this proxy rule.</p>
              </div>
              <div>
                <label htmlFor="nginx-wizard-domain" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Proxy Hostname</label>
                <input 
                  id="nginx-wizard-domain"
                  type="text"
                  value={nginxWizardData.domain}
                  onChange={e => setNginxWizardData(prev => ({ ...prev, domain: e.target.value }))}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all text-slate-100 font-mono"
                  placeholder="e.g. odoo.vpn.local"
                />
              </div>
              <div>
                <label htmlFor="nginx-wizard-upload-limit" className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Client Max Body Size (Upload Limit)</label>
                <select
                  id="nginx-wizard-upload-limit"
                  value={nginxWizardData.maxBodySize}
                  onChange={e => setNginxWizardData(prev => ({ ...prev, maxBodySize: e.target.value }))}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-5 py-4 text-sm focus:border-blue-500 transition-all text-slate-100"
                >
                  <option value="1M">1 Megabyte (Standard API)</option>
                  <option value="10M">10 Megabytes (Standard Web Apps)</option>
                  <option value="100M">100 Megabytes (WordPress Media)</option>
                  <option value="1G">1 Gigabyte (Nextcloud Small Files)</option>
                  <option value="10G">10 Gigabytes (Large Backups / DB Dumps)</option>
                </select>
              </div>
            </div>
          )}

          {nginxWizardStep === 3 && (() => {
            const dep = deployments.find((d) => d.id === nginxWizardData.deploymentId);
            const cluster = dep ? clusters.find((c) => c.id === dep.clusterId) : null;
            const clusterName = cluster ? cluster.name : 'unknown';
            const ns = dep ? dep.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') : '';
            const serviceName = dep ? (dep.appType === 'prometheus' ? 'prometheus-server' : dep.appType || 'odoo') : '';
            const port = dep ? (dep.appType === 'odoo' ? '8069' : '80') : '80';
            
            const generatedConfig = `
# Proxy configuration for ${dep ? dep.name : ''} (${dep ? dep.appType : ''}) on cluster ${clusterName}
server {
    listen 80;
    server_name ${nginxWizardData.domain};
    client_max_body_size ${nginxWizardData.maxBodySize};

    location / {
        resolver 127.0.0.11 valid=10s;
        set $upstream "${serviceName}.${ns}.svc.cluster.local:${port}";
        proxy_pass http://$upstream;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}`;

            const handleInjectAndClose = () => {
              onAppend((current) => insertServerBlock(current, generatedConfig));
              onClose();
            };

            return (
              <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                <div className="p-6 bg-green-500/5 rounded-2xl border border-green-500/10">
                  <h4 className="font-bold flex items-center gap-2 mb-2"><Check className="text-green-500" size={18}/> Review Configuration</h4>
                  <p className="text-slate-400 text-sm">Review the generated Nginx proxy block configuration before injecting.</p>
                </div>
                <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6">
                  <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-3">Generated Nginx server block</span>
                  <pre className="bg-slate-950 p-4 rounded-xl font-mono text-xs text-slate-300 overflow-x-auto max-h-[30vh] custom-scrollbar border border-slate-800">
                    {generatedConfig.trim()}
                  </pre>
                </div>
                
                <div className="mt-8 flex gap-4 pt-6 border-t border-slate-700">
                  <button onClick={() => setNginxWizardStep(2)} className="px-6 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 flex items-center gap-2 font-bold transition-all"><ArrowLeft size={18} /> Back</button>
                  <div className="flex-1"></div>
                  <button onClick={handleInjectAndClose} className="px-8 py-3 rounded-xl bg-green-600 hover:bg-green-500 shadow-lg font-bold transition-all flex items-center gap-2">🚀 Inject into config & Close</button>
                </div>
              </div>
            );
          })()}
        </div>
        
        {nginxWizardStep < 3 && (
          <div className="mt-8 flex gap-4 pt-6 border-t border-slate-700">
            {nginxWizardStep > 1 && (
              <button onClick={() => setNginxWizardStep(1)} className="px-6 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 flex items-center gap-2 font-bold transition-all"><ArrowLeft size={18} /> Back</button>
            )}
            <button onClick={() => setShowNginxWizard(false)} className="px-6 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 font-bold transition-all">Cancel</button>
            <div className="flex-1"></div>
            <button
              disabled={nginxWizardStep === 1 && !nginxWizardData.deploymentId || nginxWizardStep === 2 && !nginxWizardData.domain}
              onClick={() => setNginxWizardStep(s => s + 1)}
              className="px-8 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 shadow-lg flex items-center gap-2 font-bold disabled:opacity-50 transition-all"
            >
              Next <ArrowRight size={18} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
