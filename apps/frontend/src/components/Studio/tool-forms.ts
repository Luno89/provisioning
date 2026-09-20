import type { EngineTool, Install } from '../../api/engineTools'

const BLANK = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g

export function blanksIn(command: string): string[] {
  return [...new Set([...command.matchAll(BLANK)].map((match) => match[1] as string))]
}

export function commandProblems(command: string, args: string[]): string[] {
  return blanksIn(command)
    .filter((blank) => !args.includes(blank))
    .map((blank) => `the command fills in {${blank}}, which is not an argument`)
}

export function packagesOf(install: Install | undefined): string {
  return install && 'packages' in install ? install.packages.join(', ') : ''
}

export function blankTool(name: string): EngineTool {
  return {
    name,
    summary: '',
    binding: 'environment',
    effect: 'read',
    parameters: { type: 'object', properties: {} },
    returns: '',
    failures: [{ when: '', says: '' }],
    command: '',
    needsBinaries: [],
    install: { via: 'base' },
    status: 'draft',
    mine: true,
    grantedTo: [],
  }
}
