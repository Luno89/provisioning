export type Where = 'root' | 'instance' | 'terminal' | 'machine' | 'nowhere';

export interface Screen {
  on: Where;
  route?: string;
  component?: string;
}

export interface Branch {
  when: string;
  outcome: string;
  decision: string;
}

export interface Step {
  id: string;
  does: string;
  screen: Screen;
  code?: string[];
  job?: string;
  decisions: string[];
  branches?: Branch[];
  assumed?: string;
}

export interface Flow {
  id: string;
  title: string;
  who: string;
  steps: Step[];
}

export interface Known {
  decisions: ReadonlySet<string>;
  files: ReadonlySet<string>;
  exportsOf: (file: string) => ReadonlySet<string>;
}

export function flowProblems(flows: readonly Flow[], known: Known): string[] {
  const problems: string[] = [];
  const stepIds = new Set<string>();
  const flowIds = new Set<string>();
  for (const flow of flows) {
    if (flowIds.has(flow.id)) problems.push(`flow ${flow.id}: the id is used twice`);
    flowIds.add(flow.id);
    if (flow.steps.length === 0) problems.push(`flow ${flow.id}: no steps`);
    for (const step of flow.steps) {
      if (stepIds.has(step.id)) problems.push(`${step.id}: the id is used twice`);
      stepIds.add(step.id);
      if (!step.id.startsWith(flow.id)) problems.push(`${step.id}: a step of flow ${flow.id} is named for another flow`);
      if (step.decisions.length === 0 && !step.assumed) problems.push(`${step.id}: rests on no decision and says no assumption`);
      for (const decision of [...step.decisions, ...(step.branches ?? []).map((branch) => branch.decision)]) {
        if (!known.decisions.has(decision)) problems.push(`${step.id}: no decision ${decision} in the register`);
      }
      const component = step.screen.component;
      if (component) {
        const [file, name] = component.split('#');
        if (!file || !name) problems.push(`${step.id}: the screen's component ${component} is not <file>#<export>`);
        else if (!known.files.has(file)) problems.push(`${step.id}: no file ${file}`);
        else if (!known.exportsOf(file).has(name)) problems.push(`${step.id}: ${file} exports no ${name}`);
      }
      if ((step.screen.on === 'root' || step.screen.on === 'instance') && !step.screen.component) problems.push(`${step.id}: a step on ${step.screen.on}'s pages names no component`);
      for (const code of step.code ?? []) {
        const [file, name] = code.split('#');
        if (!file || !name) problems.push(`${step.id}: its code ${code} is not <file>#<function>`);
        else if (!known.files.has(file)) problems.push(`${step.id}: no file ${file}`);
        else if (name !== '(script)' && !known.exportsOf(file).has(name)) problems.push(`${step.id}: ${file} exports no ${name}`);
      }
    }
  }
  return problems;
}

export function stepsOf(flows: readonly Flow[]): Map<string, string[]> {
  const steps = new Map<string, string[]>();
  for (const step of flows.flatMap((flow) => flow.steps)) {
    for (const decision of new Set([...step.decisions, ...(step.branches ?? []).map((branch) => branch.decision)])) {
      steps.set(decision, [...(steps.get(decision) ?? []), step.id]);
    }
  }
  return steps;
}
