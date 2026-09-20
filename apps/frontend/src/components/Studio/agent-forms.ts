import type { Agent, GrantableTool } from '../../api/agents'
import type { RequiredGrant } from '../../api/procedures'

export const NEEDS: Record<string, string> = {
  terminal: 'a shell',
  filesystem: 'files',
  git: 'git',
  egress: 'the network',
}

export function toolProblem(tool: GrantableTool, environment: Agent['environment']): string | undefined {
  const missing = tool.needs.filter((need) => environment[need as keyof Agent['environment']] !== true)
  if (missing.length === 0) return undefined

  return `needs ${missing.map((need) => NEEDS[need] ?? need).join(' and ')}`
}

export function blankAgent(procedure: string): Agent {
  return {
    slug: '',
    name: '',
    description: '',
    version: '1',
    prompt: '',
    guidance: '',
    returns: '',
    failures: [],
    procedure,
    tools: [],
    environment: {},
    mine: true,
  }
}

export function requirementFor(
  requires: readonly RequiredGrant[],
  kind: RequiredGrant['kind'],
  name: string,
): RequiredGrant | undefined {
  return requires.find((entry) => entry.kind === kind && entry.name === name)
}

export function withRequired(agent: Agent, requires: readonly RequiredGrant[]): Agent {
  const tools = requires.filter((entry) => entry.kind === 'tool').map((entry) => entry.name)
  const agents = requires.filter((entry) => entry.kind === 'agent').map((entry) => entry.name)

  return {
    ...agent,
    tools: [...new Set([...agent.tools, ...tools])],
    agents: [...new Set([...(agent.agents ?? []), ...agents])],
  }
}
