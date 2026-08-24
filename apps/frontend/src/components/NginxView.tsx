import { Shield, Loader2, Plus, Check, AlertTriangle, Puzzle, Terminal } from 'lucide-react';
import type { UseMutationResult } from '@tanstack/react-query';
import type { Dispatch, SetStateAction } from 'react';

/**
 * The Nginx router screen.
 *
 * ── WHY IT IS ITS OWN FILE ──
 * 191 lines of it lived inside App's single 3,000-line component, between the clusters table and the
 * modals, sharing a scope with every other screen in the product. It needs ten things from App and
 * nothing else, so it was only ever there because that is where it was written.
 *
 * Moved mechanically rather than retyped: the markup and handlers are byte-for-byte what they were,
 * which is the only way to be sure a screen with no test coverage still behaves the same.
 */

export default function NginxView({
  editorContent, setEditorContent, loadingNginxConfig, updateNginxConfig,
  deployments, clusters, vpnDomains, setVpnDomains,
  onAddRoute,
}: {
  editorContent: string;
  // A React setter, not a plain callback: the wizard appends with a function updater.
  setEditorContent: Dispatch<SetStateAction<string>>;
  loadingNginxConfig: boolean;
  /**
   * The react-query mutation that writes the config back.
   *
   * Typed with the library's own `UseMutationResult` rather than a hand-listed shape: the first
   * attempt named `isPending` and `mutate` and the compiler then found `isSuccess`, `isError` and
   * `error` in the markup one at a time.
   */
  updateNginxConfig: UseMutationResult<any, any, string, any>;
  deployments: any[];
  clusters: any[];
  /** Domain per deployment id, not a list — the compiler caught this at the call site. */
  vpnDomains: Record<string, string>;
  // A React setter, for the same reason as `setEditorContent` above: the hostname input updates
  // one key with a function updater. Typed as `any`, it was the ONLY error `strict` reported in
  // the whole frontend — `prev` had nothing to infer from.
  setVpnDomains: Dispatch<SetStateAction<Record<string, string>>>;
  /**
   * Opens the route wizard.
   *
   * This took `setShowNginxWizard`, `setNginxWizardStep` AND `setNginxWizardData` — three of App's
   * raw setters, used in one `onClick` to reset a wizard before opening it. The wizard unmounts on
   * close, so it resets itself.
   */
  onAddRoute: () => void;
}) {
  return (
        <section className="animate-in fade-in slide-in-from-bottom-4 duration-300 max-w-5xl">
          <header className="flex justify-between items-center mb-10">
            <div>
              <h2 className="text-3xl font-bold">Nginx Router Settings</h2>
              <p className="text-slate-400">Configure global ingress limits, custom proxy settings, and HTTP configurations.</p>
            </div>
            <div className="flex gap-4">
              <button
                type="button"
                onClick={onAddRoute}
                className="bg-slate-700 hover:bg-slate-600 text-slate-200 px-5 py-2.5 rounded-xl flex items-center gap-2 font-semibold shadow-md transition-all cursor-pointer"
              >
                <Shield size={18} /> Proxy Wizard
              </button>
              <button
                disabled={loadingNginxConfig || updateNginxConfig.isPending}
                onClick={() => updateNginxConfig.mutate(editorContent)}
                className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-xl flex items-center gap-2 font-bold shadow-lg disabled:opacity-50 transition-all hover:scale-105 animate-all cursor-pointer"
              >
                {updateNginxConfig.isPending ? (
                  <Loader2 className="animate-spin" size={18} />
                ) : (
                  <Check size={18} />
                )}
                Save & Reload Nginx
              </button>
            </div>
          </header>
          
          {updateNginxConfig.isSuccess && (
            <div className="mb-6 p-4 bg-green-500/10 border border-green-500/20 text-green-400 rounded-xl text-sm font-semibold flex items-center gap-2 animate-in fade-in zoom-in-95">
              <Check size={16} /> Nginx configuration saved and reloaded successfully!
            </div>
          )}
          {updateNginxConfig.isError && (
            <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-sm font-semibold flex items-center gap-2 animate-in fade-in zoom-in-95">
              <AlertTriangle size={16} /> {(updateNginxConfig.error as any)?.response?.data?.error || updateNginxConfig.error.message}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-4">
              <div className="bg-slate-950 rounded-2xl border border-slate-800 p-6 shadow-inner relative flex flex-col h-[65vh]">
                <div className="flex justify-between items-center mb-3">
                  <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">nginx.conf Editor</span>
                  <span className="text-[9px] px-2 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">etc/nginx/nginx.conf</span>
                </div>
                {loadingNginxConfig ? (
                  <div className="flex-1 flex items-center justify-center">
                    <Loader2 className="animate-spin text-blue-500" size={32} />
                  </div>
                ) : (
                  <textarea
                    value={editorContent}
                    onChange={(e) => setEditorContent(e.target.value)}
                    className="flex-1 bg-transparent border-0 focus:ring-0 focus:outline-none p-0 font-mono text-xs text-slate-300 leading-relaxed resize-none custom-scrollbar"
                    placeholder="Loading configuration..."
                    rows={25}
                  />
                )}
              </div>
            </div>

            <div className="space-y-6">
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-6 shadow-sm">
                <h4 className="font-bold flex items-center gap-2 text-sm text-slate-200 mb-4"><Shield className="text-blue-500" size={16} /> VPN Domain Routing Helper</h4>
                <p className="text-slate-400 text-xs mb-4 leading-relaxed">
                  Generate Nginx reverse-proxy server blocks to route traffic from a dedicated VPN IP to your cluster's applications.
                </p>
                
                {deployments.length === 0 ? (
                  <div className="text-xs italic text-slate-500 py-3 text-center">
                    No active deployments found. Deploy an app first.
                  </div>
                ) : (
                  <div className="space-y-4 max-h-[40vh] overflow-y-auto pr-2 custom-scrollbar">
                    {deployments.map((d: any) => {
                      const cluster = clusters.find((c: any) => c.id === d.clusterId);
                      const clusterName = cluster ? cluster.name : 'unknown';
                      const ns = d.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
                      
                      // Determine service name and port based on appType
                      const serviceName = d.appType === 'prometheus' ? 'prometheus-server' : d.appType || 'odoo';
                      const port = d.appType === 'odoo' ? '8069' : '80';
                      const internalDns = `http://${serviceName}.${ns}.svc.cluster.local:${port}`;
                      
                      const domainKey = `${d.id}`;
                      const currentDomain = vpnDomains[domainKey] || `${d.name.toLowerCase()}.vpn.local`;
                      
                      const nginxBlock = `
  # Proxy configuration for ${d.name} (${d.appType}) on cluster ${clusterName}
  server {
      listen 80;
      server_name ${currentDomain};

      location / {
          proxy_pass ${internalDns};
          proxy_set_header Host $host;
          proxy_set_header X-Real-IP $remote_addr;
          proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
          proxy_set_header X-Forwarded-Proto $scheme;
      }
  }`;

                      const handleInsert = () => {
                        if (editorContent.includes('http {')) {
                          const lastBraceIdx = editorContent.lastIndexOf('}');
                          if (lastBraceIdx !== -1) {
                            const newContent = editorContent.slice(0, lastBraceIdx) + nginxBlock + '\n' + editorContent.slice(lastBraceIdx);
                            setEditorContent(newContent);
                            return;
                          }
                        }
                        setEditorContent(prev => prev + '\n' + nginxBlock);
                      };

                      return (
                        <div key={d.id} className="p-4 bg-slate-900/60 border border-slate-700/60 rounded-xl space-y-3">
                          <div className="flex justify-between items-center">
                            <span className="font-bold text-slate-200 text-xs">{d.name}</span>
                            <span className="text-[9px] px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 font-mono font-bold uppercase">{d.appType || 'odoo'}</span>
                          </div>
                          <div className="text-[10px] text-slate-400 space-y-1">
                            <div><span className="text-slate-500">Cluster:</span> <span className="font-mono text-slate-300">{clusterName}</span></div>
                            <div><span className="text-slate-500">Namespace:</span> <span className="font-mono text-slate-300">{ns}</span></div>
                            <div><span className="text-slate-500">Internal DNS:</span> <span className="font-mono text-[9px] text-slate-300">{internalDns}</span></div>
                          </div>
                          <div>
                            <label className="block text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1.5">Proxy Hostname</label>
                            <input 
                              type="text"
                              value={currentDomain}
                              onChange={e => setVpnDomains(prev => ({ ...prev, [domainKey]: e.target.value }))}
                              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-300 focus:border-blue-500 transition-all font-mono"
                              placeholder="e.g. app.vpn.local"
                            />
                          </div>
                          <div className="flex gap-2 pt-1">
                            <button 
                              onClick={handleInsert}
                              className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-bold py-1.5 px-3 rounded-lg text-[10px] transition-all flex items-center justify-center gap-1 cursor-pointer"
                            >
                              <Plus size={12} /> Inject config
                            </button>
                            <button 
                              onClick={() => {
                                navigator.clipboard.writeText(nginxBlock);
                              }}
                              className="bg-slate-700 hover:bg-slate-600 text-slate-300 font-bold py-1.5 px-3 rounded-lg text-[10px] transition-all cursor-pointer"
                            >
                              Copy
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-6 shadow-sm">
                <h4 className="font-bold flex items-center gap-2 text-sm text-slate-200 mb-4"><Puzzle className="text-blue-500" size={16} /> Configuration Hints</h4>
                <div className="space-y-4 text-xs text-slate-400 leading-relaxed">
                  <p>To configure file upload limits (e.g. for WordPress or Odoo ERP), add the following line inside the <code className="bg-slate-900 px-1.5 py-0.5 rounded text-blue-400 font-mono">http &#123; ... &#125;</code> block:</p>
                  <pre className="bg-slate-950 p-3 rounded-lg font-mono text-[11px] text-slate-300 border border-slate-800/60 leading-normal">client_max_body_size 10G;</pre>
                  <p>This allows transfers of large database dumps, media, and system files without causing "413 Request Entity Too Large" errors.</p>
                </div>
              </div>
              
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-6 shadow-sm">
                <h4 className="font-bold flex items-center gap-2 text-sm text-slate-200 mb-4"><Terminal className="text-blue-500" size={16} /> Container Status</h4>
                <div className="space-y-3 text-xs text-slate-400">
                  <div className="flex justify-between items-center">
                    <span>Proxy Service</span>
                    <span className="font-bold text-green-400 bg-green-500/10 px-2 py-0.5 rounded border border-green-500/20 text-[10px] uppercase">Active</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Host Port</span>
                    <span className="font-mono text-slate-300">80</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Tunnel Port</span>
                    <span className="font-mono text-slate-300">8000</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
  );
}
