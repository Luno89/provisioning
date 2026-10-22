export const deployStatusClass = (status: string) => (
  status === 'running' ? 'bg-green-500/10 text-green-400'
  : status === 'unhealthy' ? 'bg-amber-500/10 text-amber-400'
  : status === 'failed' ? 'bg-red-500/10 text-red-400'
  : status === 'deploying' || status === 'destroying' ? 'bg-yellow-500/10 text-yellow-400'
  : 'bg-slate-500/10 text-slate-400'
);
