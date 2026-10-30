import { CheckCircle2, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import type { LocalAgentDevice } from '../api';
import { agentUpdateLine, type AgentUpdateTone } from '../lib/agent-update';

const TONE_STYLE: Record<AgentUpdateTone, string> = {
  ok: 'text-slate-500',
  busy: 'text-sky-300',
  warn: 'text-amber-400',
  bad: 'text-red-400',
};

function ToneIcon({ tone, updating }: { tone: AgentUpdateTone; updating: boolean }) {
  if (updating) return <Loader2 size={11} className="animate-spin shrink-0 mt-0.5" />;
  if (tone === 'ok') return <CheckCircle2 size={11} className="shrink-0 mt-0.5" />;
  if (tone === 'busy') return <RefreshCw size={11} className="shrink-0 mt-0.5" />;
  return <TriangleAlert size={11} className="shrink-0 mt-0.5" />;
}

export default function MachineAgentUpdate({ device }: { device: LocalAgentDevice }) {
  const line = agentUpdateLine(device.agentUpdate, device.online);
  if (!line) return null;
  return (
    <div className={`text-[11px] mt-1 flex items-start gap-1.5 ${TONE_STYLE[line.tone]}`} data-testid="agent-update">
      <ToneIcon tone={line.tone} updating={device.agentUpdate?.state === 'updating'} />
      <span>{line.text}</span>
    </div>
  );
}
