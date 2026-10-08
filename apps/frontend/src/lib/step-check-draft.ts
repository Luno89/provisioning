import { definitionFor, type NodeCatalogue, type NodeTrace } from '@koala/agent-engine/procedure'
import type { Scenario } from '../api/evals'
import { stepProcedureId } from './scenario-draft'

const SUPPLIED = ['environment', 'persona', 'modelBinding']

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'node'

export interface StepSource {
  trace: Pick<NodeTrace, 'node' | 'kind' | 'role' | 'inputs' | 'outputs' | 'exit'>
  settings: Record<string, unknown>
  agent: string
  message: string
  procedure: string
  catalogue: NodeCatalogue
  now?: number | undefined
}

export function stepCheckFrom(source: StepSource): Scenario {
  const { trace, settings, catalogue } = source
  const definition = definitionFor(catalogue, { kind: trace.kind, settings })
  const received = (trace.inputs && typeof trace.inputs === 'object' ? trace.inputs : {}) as Record<string, unknown>
  const inputs = Object.fromEntries(
    Object.entries(received).filter(([name, value]) => {
      const socket = definition?.inputs.find((candidate) => candidate.name === name)
      return socket !== undefined && !SUPPLIED.includes(socket.type) && value !== undefined
    }),
  )
  const id = `step-${slug(trace.kind)}-${(source.now ?? Date.now()).toString(36)}`
  const outputs = trace.outputs && typeof trace.outputs === 'object' ? trace.outputs as Record<string, unknown> : {}
  const firstOutput = definition?.outputs[0]?.name

  return {
    id,
    name: `${definition?.title ?? trace.kind} as it ran at ${trace.node}`,
    describe: `Step: the ${definition?.title ?? trace.kind} node "${trace.node}" given the inputs it had in a real run, expected to do what it did then.`,
    agent: source.agent,
    procedure: { id: stepProcedureId(id) },
    step: { node: trace.kind, settings, ...(Object.keys(inputs).length > 0 ? { inputs } : {}), from: source.procedure },
    input: { message: source.message || 'Run the step.' },
    expect: trace.role === 'step' && trace.exit
      ? { exit: trace.exit }
      : firstOutput && firstOutput in outputs ? { outputs: { [firstOutput]: { equals: outputs[firstOutput] } } } : { outcome: 'ok' },
  }
}
