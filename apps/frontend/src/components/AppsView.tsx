import { Activity, ExternalLink, Plus, Shield, Trash2 } from 'lucide-react';
import { deployStatusClass } from '../lib/deploy-status.js';
import { NO_WEB_UI_APP_TYPES } from '../lib/app-ui.js';

/**
 * The deployed applications table.
 *
 * ── WHY IT IS ITS OWN FILE ──
 * 39 lines inside App's single component. Small, but it is one of the fourteen screens sharing that
 * scope, and the reason App is 3,000 lines is that each of them looked too small to move.
 *
 * `deployStatusClass` moved to lib alongside it: a status colour is not App's business, and leaving
 * it behind would have this import from a component file, which is how a UI file becomes a module
 * everything depends on.
 */

export default function AppsView(props: any) {
  const {
    deployments, clusters, setShowAppModal, setConfirmDestroy, openDashboard,
    setWizardStep, setWizardData, setShowVllmAdvanced, setShowTabbyAdvanced,
  } = props;
  return (
        <section>
          <header className="flex justify-between items-center mb-10"><div><h2 className="text-3xl font-bold">Applications</h2><p className="text-slate-400">Deploy application instances.</p></div><button onClick={() => { setShowAppModal(true); setWizardStep(1); setWizardData({ name: 'Odoo-Production', clusterId: '', appType: 'odoo', strategy: 'native', odooRepo: 'library/odoo', odooTag: '18.0', pgRepo: 'library/postgres', pgTag: '16.4', modules: [], vpnEnabled: false, vpnProtocol: 'wireguard', vpnConfig: '', vpnDedicatedIp: '', vllmMaxModelLen: '', vllmGpuMemUtil: '', vllmExtraArgs: '', vllmToolCallingEnabled: false, vllmToolCallParser: '', vllmServedModelName: '', vllmMaxNumSeqs: '', vllmDtype: '', vllmEnablePrefixCaching: false, tabbyModel: 'turboderp/Qwen3.6-27B-exl3', tabbyRevision: '', tabbyGpuCount: '2', tabbyHfToken: '', tabbyImageTag: 'latest', tabbyCacheMode: 'Q8', tabbyMaxSeqLen: '32768', tabbyMaxBatchSize: '', tabbyReasoning: true, tabbyToolFormat: 'qwen3_coder', tabbyInlineModelLoading: false, tabbyDisableAuth: true, tabbyMemoryLimit: '', tabbyShmSize: '', tabbyCpuLimit: '10', tabbyExtraEnv: '', openWebuiTargetId: '', hermesTargetId: '', webuiEnableWebSearch: true, webuiWebSearchEngine: 'duckduckgo', webuiWebSearchApiKey: '', palworldPlayers: '16' }); setShowVllmAdvanced(false); setShowTabbyAdvanced(false); }} className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl flex items-center gap-2 font-medium shadow-lg transition-all hover:scale-105"><Plus size={20} /> Deploy App</button></header>
          <div className="bg-slate-800 rounded-2xl border border-slate-700 overflow-hidden shadow-sm">
             <table className="w-full text-left">
                <thead className="bg-slate-700/30 text-slate-400 text-[10px] uppercase tracking-widest font-bold"><tr><th className="px-8 py-4">App</th><th className="px-8 py-4">Cluster</th><th className="px-8 py-4">Strategy</th><th className="px-8 py-4">Status</th><th className="px-8 py-4 text-right">Actions</th></tr></thead>
                <tbody className="divide-y divide-slate-700">{deployments.map((a: any) => (
                  <tr key={a.id} className="hover:bg-slate-700/10">
                    <td className="px-8 py-5">
                      <div className="flex items-center gap-3">
                        <span className="text-[10px] px-2.5 py-1 rounded-md font-bold uppercase tracking-wider bg-slate-900 border border-slate-700 text-slate-300">
                          {a.appType || 'odoo'}
                        </span>
                        <div className="flex flex-col gap-1">
                          {a.status === 'running' && !NO_WEB_UI_APP_TYPES.has(a.appType || '') ? (
                            <a href={a.url} target="_blank" rel="noreferrer" className="group flex items-center gap-2 w-fit">
                              <span className="font-bold text-xl text-blue-400 group-hover:text-blue-300 transition-colors underline decoration-blue-500/30 underline-offset-4">{a.name}</span>
                              <ExternalLink size={16} className="text-slate-600 group-hover:text-blue-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all" />
                            </a>
                          ) : (
                            <span className="font-bold text-xl text-slate-500">{a.name}</span>
                          )}
                          {a.isExposed && a.exposureUrl && (
                            <a href={a.exposureUrl + (a.exposurePath || '')} target="_blank" rel="noreferrer" className="group flex items-center gap-1 text-xs text-green-400 hover:text-green-300 transition-colors w-fit font-semibold mt-1">
                              <span>Exposed: {a.exposureUrl}{a.exposurePath || ''}</span>
                              <ExternalLink size={12} className="opacity-60 group-hover:opacity-100 transition-opacity" />
                            </a>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-8 py-5 text-slate-400">{clusters.find((c:any) => c.id === a.clusterId)?.name || 'Unknown'}</td><td className="px-8 py-5"><div className="flex flex-col gap-1.5 items-start"><span className="text-[10px] px-3 py-1 rounded-full font-bold uppercase bg-slate-500/10 text-slate-400">{a.strategy || 'helm'}</span>{a.vpnEnabled && (<span className="text-[9px] px-2.5 py-0.5 rounded-md font-bold uppercase tracking-wider bg-green-500/10 text-green-400 border border-green-500/20 flex items-center gap-1"><Shield size={10} /> VPN</span>)}</div></td><td className="px-8 py-5"><span title={a.healthReason || undefined} className={`text-[10px] px-3 py-1 rounded-full font-bold uppercase ${deployStatusClass(a.status)}`}>{a.status}</span></td>
                    <td className="px-8 py-5 text-right flex justify-end items-center gap-3">
                      <button onClick={() => openDashboard('app', a.id)} className="px-4 py-2 bg-blue-600/10 hover:bg-blue-600 border border-blue-500/30 text-blue-400 hover:text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1.5"><Activity size={14} /> Manage</button>
                      <button onClick={() => setConfirmDestroy({ type: 'app', id: a.id, name: a.name, isAbort: a.status === 'deploying' })} className="px-4 py-2 bg-slate-700/50 hover:bg-red-600 border border-slate-600 hover:border-red-500 text-slate-300 hover:text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1.5"><Trash2 size={14} /> Destroy</button>
                    </td>
                  </tr>))}</tbody>
              </table>
            </div>
         </section>
  );
}
