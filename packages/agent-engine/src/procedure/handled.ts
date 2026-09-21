import type { Procedure } from './schema.js';

export interface HandledStep {
  node: string;
  tool: string;
  says: string;
}

export type HandledTools = Readonly<Record<string, string>>;

const textOf = (settings: Record<string, unknown>, key: string): string =>
  (typeof settings[key] === 'string' ? settings[key] : '');

export function handledSteps(procedure: Pick<Procedure, 'nodes'> | undefined): HandledStep[] {
  const steps: HandledStep[] = [];

  for (const node of procedure?.nodes ?? []) {
    if (node.settings.shared === true) continue;

    const named = node.kind === 'call-tool' ? 'tool' : node.kind === 'delegate' ? 'agent' : undefined;
    if (!named) continue;

    const tool = textOf(node.settings, named);
    if (!tool) continue;

    steps.push({ node: node.id, tool, says: textOf(node.settings, 'says') });
  }

  return steps;
}

export function handledTools(procedure: Pick<Procedure, 'nodes'> | undefined): HandledTools {
  const byTool: Record<string, string> = {};

  for (const step of handledSteps(procedure)) {
    const said = step.says || `the procedure calls ${step.tool} for you`;
    const already = byTool[step.tool];
    byTool[step.tool] = already && already !== said ? `${already} ${said}` : said;
  }

  return byTool;
}

export function describeHandles(handles: HandledTools | undefined): string {
  const lines = [...new Set(Object.values(handles ?? {}))];
  if (lines.length === 0) return '';

  return ['WHAT THE PROCEDURE DOES AROUND YOU', '', ...lines.map((line) => `- ${line}`)].join('\n');
}

export function describeHandledSteps(procedure: Pick<Procedure, 'nodes'> | undefined): string {
  return describeHandles(handledTools(procedure));
}
