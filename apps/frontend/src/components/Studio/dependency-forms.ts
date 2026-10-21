import type { DependencyInstall, DependencyView, WorkspaceDependency } from '../../api/workspaceDependencies'

export const INSTALL_MANAGERS = ['dnf', 'apt', 'pip', 'npm'] as const

export interface InstallForm {
  packages: Record<string, string>
  script: string
}

export interface DependencyForm {
  name: string
  summary: string
  provides: string
  libraries: string
  needs: string[]
  install: InstallForm
  onDebian: InstallForm
}

const namesIn = (text: string): string[] => [...new Set(text.split(/[\s,]+/).map((name) => name.trim()).filter(Boolean))]

function installFormOf(install: readonly DependencyInstall[] | undefined): InstallForm {
  return {
    packages: Object.fromEntries(INSTALL_MANAGERS.map((manager) => [manager, (install ?? []).flatMap((step) => (step.via === manager ? step.packages : [])).join(' ')])),
    script: (install ?? []).flatMap((step) => (step.via === 'script' ? [step.run] : [])).join('\n'),
  }
}

function installOf(form: InstallForm): DependencyInstall[] {
  return [
    ...INSTALL_MANAGERS.flatMap((manager): DependencyInstall[] => {
      const packages = namesIn(form.packages[manager] ?? '')
      return packages.length ? [{ via: manager, packages }] : []
    }),
    ...(form.script.trim() ? [{ via: 'script' as const, run: form.script.trim() }] : []),
  ]
}

export function dependencyForm(dependency: Partial<WorkspaceDependency> & { name: string }): DependencyForm {
  return {
    name: dependency.name,
    summary: dependency.summary ?? '',
    provides: (dependency.provides ?? []).join(', '),
    libraries: (dependency.libraries ?? []).join(', '),
    needs: [...(dependency.needs ?? [])],
    install: installFormOf(dependency.install),
    onDebian: installFormOf(dependency.onDebian),
  }
}

export function dependencyOf(form: DependencyForm): WorkspaceDependency {
  const libraries = namesIn(form.libraries)
  const onDebian = installOf(form.onDebian)
  return {
    name: form.name.trim(),
    summary: form.summary.trim(),
    provides: namesIn(form.provides),
    ...(libraries.length ? { libraries } : {}),
    ...(form.needs.length ? { needs: [...form.needs] } : {}),
    install: installOf(form.install),
    ...(onDebian.length ? { onDebian } : {}),
  }
}

export function installLines(install: readonly DependencyInstall[]): string[] {
  return install.map((step) => (step.via === 'script' ? scriptLine(step.run) : `${step.via} ${step.packages.join(' ')}`))
}

const WRITTEN = /^echo ([A-Za-z0-9+/=]+) \| base64 -d > (\S+)(.*)$/

function scriptLine(run: string): string {
  const written = WRITTEN.exec(run)
  if (!written) return `script: ${run}`
  let content: string
  try {
    content = new TextDecoder().decode(Uint8Array.from(atob(written[1]!), (char) => char.charCodeAt(0)))
  } catch {
    return `script: ${run}`
  }
  const then = written[3]!.replace(/^\s*&&\s*/, '').trim()
  return `script: writes ${written[2]}${then ? `, then ${then}` : ''}:\n${content.trimEnd()}`
}

export function usedByLines(view: Pick<DependencyView, 'usedBy'>): string[] {
  const { tools, servers, dependencies, steps, trees } = view.usedBy
  return [
    ...tools.map((name) => `the tool ${name}`),
    ...servers.map((name) => `the MCP server ${name}`),
    ...dependencies.map((name) => `the dependency ${name}`),
    ...steps.map((title) => `the step ${title}, in every agent whose procedure runs it`),
    ...trees.map((tree) => `the workspace of the tree ${tree.name}`),
  ]
}
