import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Terminal, X } from 'lucide-react';
import { AnsiText } from './AnsiText.js';
import { getPipelineLog, projectKeys } from '../api/projects.js';
import { useLogSocket } from '../stores/socket.js';

export default function PipelineLogModal({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [socketLogs, setSocketLogs] = useState('');

  const { data: initialLog } = useQuery({
    queryKey: projectKeys.log(runId),
    queryFn: () => getPipelineLog(runId),
  });

  useLogSocket({
    room: runId,
    onChunk: (chunk) => setSocketLogs((prev) => prev + chunk),
    onReconnect: () => setSocketLogs(''),
  });

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-[var(--bark-950)] border border-[var(--bark-700)] rounded-lg w-full max-w-4xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden">
        <div className="flex justify-between items-center px-4 py-3 border-b border-[var(--bark-800)] bg-[var(--bark-900)]">
          <h3 className="text-xs font-semibold text-slate-200 flex items-center gap-2 font-mono">
            <Terminal size={15} className="text-blue-400" /> Pipeline Build Output
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 bg-slate-950 font-mono text-xs text-slate-200 custom-scrollbar leading-relaxed">
          <AnsiText text={((initialLog?.content || '') + socketLogs) || 'Connecting to build log stream...'} />
        </div>
      </div>
    </div>
  );
}
