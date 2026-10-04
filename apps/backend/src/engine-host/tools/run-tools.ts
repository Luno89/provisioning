import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import type { StoredNodeTrace } from '../../lib/run-traces.js';

export interface RunReader {
  traces(ownerId: string, runId: string): Promise<StoredNodeTrace[]>;
}

const SUMMARY_CHARS = 240;

const refuse = (reason: string): ToolOutcome => ({ ok: false, digest: reason, content: reason });

const text = (value: unknown): string => {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

const oneLine = (value: unknown): string => {
  const flat = text(value).replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS)}…` : flat;
};

export function runOverview(traces: readonly StoredNodeTrace[]): string {
  const first = traces[0]!;
  const lines = traces.map((trace) => {
    const how = trace.error ? `error: ${oneLine(trace.error)}`
      : trace.interrupted ? `interrupted: ${oneLine(trace.interrupted)}`
        : trace.finish ? `finished ${trace.finish.outcome}${trace.finish.reason ? `: ${oneLine(trace.finish.reason)}` : ''}`
          : trace.exit ? `→ ${trace.exit}` : '';
    const produced = trace.outputs === undefined || trace.finish ? '' : `\n    ${oneLine(trace.outputs)}`;
    return `#${trace.sequence} ${trace.node} (${trace.kind}${trace.cleanup ? ', cleanup' : ''}) ${how}${produced}`;
  });
  return [`run ${first.runId} — agent ${first.agentSlug}, procedure ${first.procedureId}@${first.procedureVersion}, ${traces.length} steps`, ...lines].join('\n');
}

export function nodeInFull(traces: readonly StoredNodeTrace[], node: string): string | undefined {
  const [name, sequence] = node.split('#');
  const chosen = traces.filter((trace) => trace.node === name && (sequence === undefined || String(trace.sequence) === sequence));
  if (chosen.length === 0) return undefined;
  return chosen.map((trace) => [
    `#${trace.sequence} ${trace.node} (${trace.kind})${trace.exit ? ` → ${trace.exit}` : ''}`,
    ...(trace.error ? [`error: ${trace.error}`] : []),
    ...(trace.interrupted ? [`interrupted: ${trace.interrupted}`] : []),
    ...(trace.finish ? [`finished ${trace.finish.outcome}${trace.finish.reason ? `: ${trace.finish.reason}` : ''}`] : []),
    `inputs: ${JSON.stringify(trace.inputs, null, 2)}`,
    ...(trace.outputs !== undefined ? [`outputs: ${JSON.stringify(trace.outputs, null, 2)}`] : []),
  ].join('\n')).join('\n\n');
}

export function createRunTools(options: { runs: RunReader }): Record<string, ToolHandler> {
  return {
    async read_run({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner whose runs to read');
      const runId = typeof parsed.runId === 'string' ? parsed.runId.trim() : '';
      if (!runId) return refuse('give the runId of the run to read');
      const traces = (await options.runs.traces(caller.ownerId, runId)).sort((a, b) => a.sequence - b.sequence);
      if (traces.length === 0) return refuse(`there is no run ${runId} of yours that recorded anything`);

      const node = typeof parsed.node === 'string' ? parsed.node.trim() : '';
      if (!node) return { ok: true, digest: `${runId}: ${traces.length} steps`, content: runOverview(traces) };

      const full = nodeInFull(traces, node);
      if (!full) {
        const names = [...new Set(traces.map((trace) => trace.node))].join(', ');
        return refuse(`run ${runId} has no node "${node}"; it has ${names}`);
      }
      return { ok: true, digest: `${runId}: ${node}`, content: full };
    },
  };
}
