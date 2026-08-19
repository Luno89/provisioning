import { AlertTriangle, ChevronDown, ChevronUp, Cloud, Cpu, FileText, Layers, Loader2, Plus, Shield, Trash2, Zap } from 'lucide-react';

/**
 * The clusters screen.
 *
 * ── WHY IT IS ITS OWN FILE ──
 * 164 lines of it sat inside App's single component, between the sidebar and the apps table,
 * sharing a scope with every other screen and every modal in the product. It reads a dozen things
 * from App and writes three, and was only ever there because that is where it was written.
 *
 * Moved mechanically rather than retyped, so the markup and handlers are byte-for-byte what they
 * were — the only way to be sure a screen with this little test coverage still behaves the same.
 * The props below are what the COMPILER said it needed; my own grep of the block missed some, which
 * is the argument for doing this in slices that typecheck.
 */

export default function ClustersView(props: any) {
  const {
    clusters, expandedCluster, setExpandedCluster,
    clusterPods, podError, loadingClusterPods, clusterHelmReleases, loadingClusterHelm,
    clusterGpuStatus, loadingClusterGpu,
    setShowClusterModal, setConfirmDestroy, openDashboard,
  } = props;
  return (
        <section>
          <header className="flex justify-between items-center mb-10"><div><h2 className="text-3xl font-bold">Infrastructures</h2><p className="text-slate-400">Manage your Kubernetes fleet.</p></div><button onClick={() => setShowClusterModal(true)} className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl flex items-center gap-2 font-medium shadow-lg transition-all hover:scale-105"><Plus size={20} /> Provision Cluster</button></header>
          <div className="grid grid-cols-1 gap-8 max-w-5xl">{clusters.map((c: any) => (
              <div key={c.id} className={c.isSystem
                ? "bg-gradient-to-br from-purple-950/60 via-slate-800 to-slate-800 rounded-3xl border-2 border-purple-500/40 overflow-hidden shadow-lg shadow-purple-950/30 transition-all"
                : "bg-slate-800 rounded-3xl border border-slate-700 overflow-hidden shadow-sm transition-all hover:border-slate-500"
              }>
                <div className="p-8">
                  <div className="flex justify-between items-center mb-6">
                    <div className="flex items-center gap-4"><div className={`p-3 rounded-2xl ${c.isSystem ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/10 text-blue-500'}`}>{c.isSystem ? <Shield size={28} /> : <Cloud size={28} />}</div><div><h4 className="font-bold text-2xl flex items-center gap-2">{c.name}{c.isSystem && (<span className="text-[9px] font-black px-2.5 py-1 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30 uppercase tracking-widest">System</span>)}</h4><span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">{c.provider} • {c.isSystem ? 'always-on management cluster · read-only' : c.id.slice(0,8)}</span></div></div>
                    <div className="flex items-center gap-3">
                      <span className={`text-[10px] font-bold px-4 py-1.5 rounded-full uppercase flex items-center gap-2 ${c.status === 'healthy' ? 'bg-green-500/10 text-green-500' : 'bg-yellow-500/10 text-yellow-500 animate-pulse'}`}>
                        <div className={`w-2 h-2 rounded-full ${c.status === 'healthy' ? 'bg-green-500' : 'bg-yellow-500'}`}></div>
                        {c.status}
                      </span>
                      {!c.isSystem && (
                        <button onClick={() => openDashboard('cluster', c.id)} className="p-2.5 bg-slate-700 hover:bg-slate-600 rounded-xl text-slate-300 transition-colors">
                          <FileText size={20} />
                        </button>
                      )}
                      {c.isSystem ? (
                        <span title="The system management cluster can't be modified from here" className="p-2.5 bg-slate-800 rounded-xl text-slate-600 cursor-not-allowed">
                          <Shield size={20} />
                        </span>
                      ) : (
                        <button onClick={() => setConfirmDestroy({ type: 'cluster', id: c.id, name: c.name, isAbort: c.status === 'provisioning' })} className="p-2.5 bg-slate-700 hover:bg-red-600 rounded-xl text-red-400 hover:text-white transition-all">
                          <Trash2 size={20} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="mt-4 pt-6 border-t border-slate-700/50">
                     <button onClick={() => setExpandedCluster(expandedCluster === c.id ? null : c.id)} className="flex items-center gap-2 text-xs font-bold text-slate-400 hover:text-white transition-colors uppercase tracking-widest">{expandedCluster === c.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Cluster Inspector</button>
                     {expandedCluster === c.id && (
                       <div className="mt-6 space-y-8 animate-in fade-in slide-in-from-top-2 duration-300">
                         <div>
                            <h5 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2"><Layers size={12} className="text-blue-400" /> Helm Chart Inventory</h5>
                            {loadingClusterHelm ? (
                              <div className="text-slate-500 text-xs italic">Scanning Helm repository...</div>
                            ) : clusterHelmReleases?.length > 0 ? (
                              <div className="grid grid-cols-2 gap-4">
                                 {clusterHelmReleases.map((release: any) => (
                                   <div key={release.name} className="bg-slate-900/50 border border-slate-700 p-4 rounded-xl flex justify-between items-center">
                                      <div>
                                        <div className="font-bold text-sm">{release.name}</div>
                                        <div className="text-[10px] text-slate-500">{release.chart} • v{release.app_version}</div>
                                      </div>
                                      <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full uppercase ${release.status === 'deployed' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>{release.status}</span>
                                   </div>
                                 ))}
                              </div>
                            ) : <div className="text-slate-600 text-xs italic">No Helm charts installed.</div>}
                         </div>
                         <div>
                            <h5 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2"><Cpu size={12} className="text-blue-400" /> Infrastructure Node Status</h5>
                            {loadingClusterPods ? (
                              <div className="text-center py-6"><Loader2 className="animate-spin text-slate-600 mx-auto" size={24} /></div>
                            ) : Array.isArray(clusterPods) && clusterPods.length > 0 ? (
                              <div className="bg-slate-900/50 rounded-2xl border border-slate-700/50 overflow-hidden"><table className="w-full text-left text-xs"><thead className="bg-slate-800/50 text-slate-500 uppercase tracking-tighter"><tr><th className="px-6 py-3">Namespace</th><th className="px-6 py-3">Pod Name</th><th className="px-6 py-3">Status</th><th className="px-6 py-3">IP</th><th className="px-6 py-3 text-right">Age</th></tr></thead>
                                  <tbody className="divide-y divide-slate-800">{clusterPods.map((pod: any) => (<tr key={pod?.metadata?.name || Math.random()} className="hover:bg-slate-800/30 transition-colors group"><td className="px-6 py-4 font-mono text-[10px] text-blue-400/80">{pod?.metadata?.namespace || '---'}</td><td className="px-6 py-4 font-bold text-slate-300 group-hover:text-white truncate max-w-[200px]">{pod?.metadata?.name || 'Unknown'}</td><td className="px-6 py-4"><div className="flex items-center gap-2"><div className={`w-1.5 h-1.5 rounded-full ${pod?.status?.phase === 'Running' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]' : 'bg-yellow-500 animate-pulse'}`}></div><span className="font-medium text-slate-400">{pod?.status?.phase || 'Pending'}</span></div></td><td className="px-6 py-4 font-mono text-slate-500 text-[10px]">{pod?.status?.podIP || '---'}</td><td className="px-6 py-4 text-right text-slate-600">{pod?.metadata?.creationTimestamp ? new Date(pod.metadata.creationTimestamp).toLocaleTimeString() : '---'}</td></tr>))}</tbody></table></div>
                            ) : <div className="text-center py-6 bg-slate-900/30 rounded-2xl border border-dashed border-slate-700 text-slate-500 text-sm">{podError ? 'API Error' : 'No nodes active.'}</div>}
                         </div>
                         <div>
                             <h5 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2"><Zap size={12} className="text-amber-400" /> GPU Acceleration & Availability</h5>
                             {loadingClusterGpu ? (
                               <div className="text-center py-4"><Loader2 className="animate-spin text-slate-600 mx-auto" size={20} /></div>
                             ) : clusterGpuStatus ? (
                               <div className="bg-slate-900/50 rounded-2xl border border-slate-700/50 p-5 space-y-4">
                                 <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
                                   <div className="flex items-center gap-3">
                                     <div className={`p-2.5 rounded-xl ${clusterGpuStatus.hasGpu || clusterGpuStatus.passthroughEnabled ? 'bg-amber-500/10 text-amber-400' : 'bg-slate-800 text-slate-500'}`}>
                                       <Zap size={20} />
                                     </div>
                                     <div>
                                       <div className="font-bold text-sm text-slate-200">
                                         {clusterGpuStatus.vendor !== 'none' ? `${clusterGpuStatus.vendor} GPU Acceleration` : 'GPU Status'}
                                       </div>
                                       <div className="text-[11px] text-slate-400">
                                         Passthrough: <span className="font-semibold text-slate-300">{c.gpuEnabled || clusterGpuStatus.passthroughEnabled ? 'Enabled' : 'Disabled'}</span>
                                       </div>
                                     </div>
                                   </div>
                                   <div className="flex items-center gap-2">
                                     {clusterGpuStatus.totalCapacity > 0 ? (
                                       <span className={`text-[10px] font-bold px-3 py-1 rounded-full uppercase flex items-center gap-1.5 ${clusterGpuStatus.availableGpus > 0 ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
                                         <div className={`w-1.5 h-1.5 rounded-full ${clusterGpuStatus.availableGpus > 0 ? 'bg-green-500' : 'bg-red-500'}`}></div>
                                         {clusterGpuStatus.availableGpus} / {clusterGpuStatus.totalAllocatable} GPU Available
                                       </span>
                                     ) : (c.gpuEnabled || clusterGpuStatus.passthroughEnabled) ? (
                                       <span className="text-[10px] font-bold px-3 py-1 rounded-full uppercase bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 flex items-center gap-1.5">
                                         <AlertTriangle size={12} />
                                         No GPU Detected on Host Node
                                       </span>
                                     ) : (
                                       <span className="text-[10px] font-bold px-3 py-1 rounded-full uppercase bg-slate-800 text-slate-400 border border-slate-700">
                                         Passthrough Disabled
                                       </span>
                                     )}
                                   </div>
                                 </div>

                                 <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                                   <div className="bg-slate-800/60 p-3 rounded-xl border border-slate-700/40">
                                     <div className="text-slate-400 text-[10px] uppercase font-bold tracking-wider">Total Capacity</div>
                                     <div className="text-lg font-bold text-slate-100 mt-0.5">{clusterGpuStatus.totalCapacity} GPU</div>
                                   </div>
                                   <div className="bg-slate-800/60 p-3 rounded-xl border border-slate-700/40">
                                     <div className="text-slate-400 text-[10px] uppercase font-bold tracking-wider">Allocatable</div>
                                     <div className="text-lg font-bold text-slate-100 mt-0.5">{clusterGpuStatus.totalAllocatable} GPU</div>
                                   </div>
                                   <div className="bg-slate-800/60 p-3 rounded-xl border border-slate-700/40">
                                     <div className="text-slate-400 text-[10px] uppercase font-bold tracking-wider">Allocated Workloads</div>
                                     <div className="text-lg font-bold text-amber-400 mt-0.5">{clusterGpuStatus.totalAllocated} GPU</div>
                                   </div>
                                   <div className="bg-slate-800/60 p-3 rounded-xl border border-slate-700/40">
                                     <div className="text-slate-400 text-[10px] uppercase font-bold tracking-wider">Available</div>
                                     <div className={`text-lg font-bold mt-0.5 ${clusterGpuStatus.availableGpus > 0 ? 'text-green-400' : 'text-slate-400'}`}>{clusterGpuStatus.availableGpus} GPU</div>
                                   </div>
                                 </div>

                                 {clusterGpuStatus.devicePlugins?.length > 0 && (
                                   <div className="pt-2 border-t border-slate-800/80">
                                     <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">Device Plugin Status</div>
                                     <div className="flex flex-wrap gap-2">
                                       {clusterGpuStatus.devicePlugins.map((dp: any) => (
                                         <div key={dp.name} className="bg-slate-800 p-2.5 rounded-lg border border-slate-700/60 flex items-center justify-between text-xs w-full">
                                           <span className="font-mono text-slate-300 text-[11px]">{dp.name}</span>
                                           <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${dp.status === 'active' ? 'bg-green-500/10 text-green-400' : 'bg-yellow-500/10 text-yellow-400'}`}>
                                             {dp.status === 'active' ? 'Active' : 'Degraded'} ({dp.readyPods}/{dp.desiredPods} pods ready)
                                           </span>
                                         </div>
                                       ))}
                                     </div>
                                   </div>
                                 )}

                                 {clusterGpuStatus.gpuPods?.length > 0 && (
                                   <div className="pt-2 border-t border-slate-800/80">
                                     <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">Active GPU Workloads</div>
                                     <div className="space-y-1.5">
                                       {clusterGpuStatus.gpuPods.map((gp: any) => (
                                         <div key={gp.name} className="bg-slate-800/70 px-3 py-2 rounded-lg border border-slate-700/50 flex justify-between items-center text-xs">
                                           <div className="flex items-center gap-2">
                                             <span className="text-amber-400 font-bold">{gp.gpus} GPU</span>
                                             <span className="font-bold text-slate-200">{gp.name}</span>
                                             <span className="text-[10px] text-slate-500 font-mono">({gp.namespace})</span>
                                           </div>
                                           <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${gp.status === 'Running' ? 'bg-green-500/10 text-green-400' : 'bg-yellow-500/10 text-yellow-400 animate-pulse'}`}>{gp.status}</span>
                                         </div>
                                       ))}
                                     </div>
                                   </div>
                                 )}
                               </div>
                             ) : <div className="text-slate-600 text-xs italic">GPU status unavailable.</div>}
                          </div>
                       </div>
                     )}
                  </div>
                </div>
              </div>
            ))}</div>
           </section>
  );
}
