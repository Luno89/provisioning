import {
  BUILT_IN_GROUPS,
  GROUP_KIND,
  PROCEDURE_SCHEMA,
  builtInCatalogue,
  checkProcedure,
  defaultSettings,
  groupLibrary,
  type NodeTrace,
  type Procedure,
  type EffortMeasure,
  type ProcedureProblem,
  type SettingSchema,
} from '@koala/agent-engine/procedure'
import { groupPathOf } from './procedure-run'
import { addNode, isRefused, type CanvasContext } from './procedure-canvas'

type RunBudget = Procedure['budget']

export const STUDIO_CONTEXT: CanvasContext = { catalogue: builtInCatalogue(), shared: BUILT_IN_GROUPS }

export function defaultFor(schema: SettingSchema): unknown {
  if (schema.default !== undefined) return structuredClone(schema.default)
  switch (schema.type) {
    case 'string':
      return schema.enum?.[0] ?? ''
    case 'number':
    case 'integer':
      return schema.minimum ?? 0
    case 'boolean':
      return false
    case 'array':
      return []
    case 'object':
      return defaultSettings(schema)
  }
}

export function procedureIdFrom(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function blankProcedure(id: string, name: string): Procedure {
  return {
    schema: PROCEDURE_SCHEMA,
    id,
    version: '0',
    name,
    describe: '',
    budget: { maxRounds: 10 },
    start: '',
    nodes: [],
    wires: [],
    flow: [],
    groups: [],
  }
}

export function starterProcedure(id: string, name: string): Procedure {
  const added = addNode(blankProcedure(id, name), [], 'finish', { x: 0, y: 0 }, STUDIO_CONTEXT)
  if (isRefused(added)) throw new Error(added.refused)
  return added.procedure
}

export function copyOf(procedure: Procedure, id: string, name: string): Procedure {
  return { ...structuredClone(procedure), id, name, version: '0' }
}

export const BUDGET_FIELDS: readonly { key: keyof RunBudget; label: string; describe: string }[] = [
  { key: 'maxRounds', label: 'Rounds', describe: 'How many times the model can be called before the run stops' },
  { key: 'maxToolCalls', label: 'Tool calls', describe: 'How many tool calls the run can make in total' },
  { key: 'maxTokens', label: 'Tokens', describe: 'How many tokens the run can spend in total' },
  { key: 'maxWallClockMs', label: 'Time (ms)', describe: 'How long the run can take, in milliseconds' },
  { key: 'maxDepth', label: 'Delegation depth', describe: 'How deep agents can hand work to other agents' },
  { key: 'maxChildRuns', label: 'Child runs', describe: 'How many runs this one can hand work to' },
]

export function describeEffort(measure: EffortMeasure, value: number): string {
  if (measure === 'wallClockMs') return value >= 60_000 ? `${Math.round(value / 6_000) / 10} min` : `${Math.round(value / 1000)} s`
  if (measure === 'totalTokens') return value >= 1000 ? `${Math.round(value / 100) / 10}k tokens` : `${value} tokens`
  const names: Record<Exclude<EffortMeasure, 'wallClockMs' | 'totalTokens'>, [string, string]> = {
    rounds: ['round', 'rounds'],
    toolCalls: ['tool call', 'tool calls'],
    childRuns: ['child run', 'child runs'],
  }
  const [one, many] = names[measure]
  return `${value} ${value === 1 ? one : many}`
}

export function withBudget(procedure: Procedure, key: keyof RunBudget, value: number | undefined): Procedure {
  const { [key]: _old, ...rest } = procedure.budget
  return { ...procedure, budget: value === undefined ? rest : { ...rest, [key]: value } }
}

export const localProblems = (procedure: Procedure, context: CanvasContext = STUDIO_CONTEXT): ProcedureProblem[] =>
  checkProcedure(procedure, { catalogue: context.catalogue, groups: context.shared ?? BUILT_IN_GROUPS })

const problemKey = (problem: ProcedureProblem) =>
  JSON.stringify([problem.severity, problem.message, problem.group, problem.node, problem.socket, problem.exit])

export function mergeProblems(local: readonly ProcedureProblem[], server: readonly ProcedureProblem[] | undefined): ProcedureProblem[] {
  if (!server) return [...local]
  const seen = new Set(server.map(problemKey))
  return [...server, ...local.filter((problem) => !seen.has(problemKey(problem)))]
}

export function groupPathIn(procedure: Procedure, nodeId: string, context: CanvasContext = STUDIO_CONTEXT): string[] {
  const library = groupLibrary(procedure, context.shared ?? BUILT_IN_GROUPS)
  return groupPathOf(nodeId, (instance) => {
    let nodes = procedure.nodes
    let group: string | undefined
    for (const id of instance) {
      const node = nodes.find((candidate) => candidate.id === id)
      if (!node || node.kind !== GROUP_KIND || !node.group) return undefined
      group = node.group
      nodes = library.get(node.group)?.nodes ?? []
    }
    return group
  })
}

export const traceLabel = (trace: NodeTrace): string =>
  trace.exit ? `${trace.node} → ${trace.exit}` : trace.node
