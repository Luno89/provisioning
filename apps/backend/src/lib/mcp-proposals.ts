import type { Install } from '@koala/agent-engine';
import { serverNameFrom, serverProblems, serverState, type McpServerRecord, type McpServerTemplate, type ServerRuns } from './mcp-servers.js';
import { code, fields, section, text, type ProposalSection } from './proposal-sections.js';

export interface ServerProposal {
  template?: string | undefined;
  server?: string | undefined;
  name: string;
  summary?: string | undefined;
  runs?: ServerRuns | undefined;
  notes?: string | undefined;
  dependsOn?: string | undefined;
  offer?: string[] | undefined;
  omit?: string[] | undefined;
  agents: string[];
  why: string;
}

export interface ProposalKnown {
  servers: readonly McpServerRecord[];
  templates: readonly McpServerTemplate[];
  agents: readonly { slug: string; servers?: readonly string[] | undefined }[];
}

export type DraftedProposal = { proposal: ServerProposal; summary: string; sections: ProposalSection[] } | { problem: string };

const trimmed = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

const list = (value: unknown): string[] | undefined | false => {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'string' ? (() => { try { return JSON.parse(value) as unknown; } catch { return value.split(',').map((entry) => entry.trim()).filter(Boolean); } })() : value;
  return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string' && entry.trim()) ? parsed.map((entry) => (entry as string).trim()) : false;
};

const object = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
};

const installLine = (install: Install): string => {
  if (install.via === 'script') return `Install script: ${install.run}`;
  if (install.via === 'base') return 'Install: what the base image has';
  return `Install with ${install.via}: ${install.packages.join(', ')}`;
};

const where = (runs: ServerRuns): string => (runs.where === 'workspace' ? 'runs in the workspace' : 'url' in runs ? 'hosted' : 'one of your deployments');

export function howItRuns(runs: ServerRuns): ProposalSection {
  if (runs.where === 'hosted') return section('How it runs', [fields('url' in runs ? ['At', runs.url, 'code'] : ['Deployment', runs.deploymentId])]);
  const packages = runs.install.flatMap((install) => (install.via === 'script' || install.via === 'base' ? [] : [[install.via, install.packages.join(' ')] as const]));
  const scripts = runs.install.flatMap((install) => (install.via === 'script' ? [install.run] : []));
  const answers = `127.0.0.1:${runs.port}${runs.path ?? '/mcp'}`;
  return section('How it runs', [
    fields(...packages, ...(runs.languages?.length ? [['languages', runs.languages.join(', ')] as const] : [])),
    ...scripts.map((script) => code(script, 'install script')),
    code(runs.start, 'start'),
    fields(['answers', answers, 'code']),
  ], [...packages.map(([via, names]) => `${via} ${names}`), `port ${runs.port}`].join(', '));
}

const givenText = (to: readonly string[], workspace: boolean): string =>
  to.map((slug) => (workspace ? `${slug} — its workspace image is rebuilt with it` : slug)).join('\n');

export function runsLines(runs: ServerRuns): string[] {
  if (runs.where === 'hosted') return ['url' in runs ? `Runs hosted at ${runs.url}` : `Runs as your deployment ${runs.deploymentId}`];
  return [
    `Runs in the workspace${runs.languages?.length ? ` (${runs.languages.join(', ')})` : ''}`,
    ...runs.install.map(installLine),
    `Started with: ${runs.start}`,
    `Answers on port ${runs.port}${runs.path ? `, ${runs.path}` : ''}`,
  ];
}

export function stateLine(server: McpServerRecord): string {
  const state = serverState(server);
  if (state.state === 'captured') return `captured, ${state.tools} tool${state.tools === 1 ? '' : 's'} offered: ${(server.captured?.tools ?? []).map((tool) => tool.name).join(', ')}`;
  if (state.state === 'capturing') return 'being captured';
  if (state.state === 'failed') return `its capture failed: ${state.why}`;
  if (state.state === 'stale') return 'changed since it was captured';
  return 'not captured yet';
}

export function draftServerProposal(parsed: Record<string, unknown>, known: ProposalKnown): DraftedProposal {
  const why = trimmed(parsed.why);
  if (!why) return { problem: 'say why, shown to the person on the card' };
  const agents = list(parsed.agents);
  if (agents === false) return { problem: 'agents has to be a list of agent slugs' };
  const unknown = (agents ?? []).filter((slug) => !known.agents.some((agent) => agent.slug === slug));
  if (unknown.length > 0) return { problem: `there is no agent called ${unknown.map((slug) => `"${slug}"`).join(', ')}` };
  const offer = list(parsed.offer);
  const omit = list(parsed.omit);
  if (offer === false || omit === false) return { problem: 'offer and omit have to be lists of tool names' };
  const extras = {
    ...(trimmed(parsed.summary) ? { summary: trimmed(parsed.summary) } : {}),
    ...(trimmed(parsed.notes) ? { notes: trimmed(parsed.notes) } : {}),
    ...(trimmed(parsed.dependsOn) ? { dependsOn: trimmed(parsed.dependsOn) } : {}),
    ...(offer ? { offer } : {}),
    ...(omit ? { omit } : {}),
  };
  const holders = (name: string) => known.agents.filter((agent) => (agent.servers ?? []).includes(name)).map((agent) => agent.slug);
  const given = (name: string) => (agents ?? []).filter((slug) => !holders(name).includes(slug));
  const extraSections = [
    ...(extras.notes ? [section('Notes for the agents', [text(extras.notes)])] : []),
    ...(extras.dependsOn || extras.offer || extras.omit ? [section('Its tools', [fields(['Depends on', extras.dependsOn], ['Offers only', extras.offer?.join(', ')], ['Leaves out', extras.omit?.join(', ')])])] : []),
  ];
  const whoGets = (name: string, workspace: boolean) => {
    const to = given(name);
    return to.length === 0 ? [section('Who gets it', [text('No agent yet — give it to one from the server\'s page.')])] : [section('Who gets it', [text(givenText(to, workspace))])];
  };

  const existing = trimmed(parsed.server);
  const templateId = trimmed(parsed.template);
  const sources = [existing, templateId, parsed.runs !== undefined ? 'runs' : undefined].filter(Boolean);
  if (sources.length !== 1) return { problem: 'propose one thing: a server you already have (server), a known one (template), or a new one (name and runs)' };

  if (existing) {
    const server = known.servers.find((candidate) => candidate.name === existing);
    if (!server) return { problem: `there is no MCP server called "${existing}"; list_mcp_servers shows the ones there are` };
    if (Object.keys(extras).length > 0) return { problem: 'a server you already have is changed on its page in the Studio; propose only who should hold it' };
    const to = given(server.name);
    if (to.length === 0) return { problem: agents?.length ? `${agents.join(', ')} already hold${agents.length === 1 ? 's' : ''} ${server.name}` : 'name the agents who should hold it' };
    const workspace = server.runs.where === 'workspace';
    return {
      proposal: { server: server.name, name: server.name, agents: to, why },
      summary: `give ${to.join(', ')} the MCP server ${server.name}`,
      sections: [
        section('What it is', [text(`${server.name} · already yours · ${where(server.runs)}`), ...(server.summary ? [text(server.summary)] : []), text(stateLine(server))]),
        ...whoGets(server.name, workspace),
      ],
    };
  }

  if (templateId) {
    const template = known.templates.find((candidate) => candidate.id === templateId);
    if (!template) return { problem: `there is no known server called "${templateId}"; known ones are ${known.templates.map((entry) => entry.id).join(', ') || 'none'}` };
    const added = known.servers.find((server) => server.from && 'template' in server.from && server.from.template === template.id);
    if (added) return { problem: `${template.id} is already added, as ${added.name}; propose server: "${added.name}" to give it to agents` };
    const taken = new Set(known.servers.map((server) => server.name));
    const name = trimmed(parsed.name) ?? serverNameFrom(template.name, taken);
    const problems = serverProblems({ name, runs: template.runs, offer: extras.offer, omit: extras.offer ? extras.omit : (extras.omit ?? template.omit) }, known.servers);
    if (problems.length > 0) return { problem: problems.join('; ') };
    return {
      proposal: { template: template.id, name, ...extras, agents: agents ?? [], why },
      summary: `add the MCP server ${name}${agents?.length ? ` for ${agents.join(', ')}` : ''}`,
      sections: [
        section('What it is', [text(`${name} · known server · ${where(template.runs)}`), text(template.summary), text('Its tools are captured as soon as it is added.')]),
        ...whoGets(name, template.runs.where === 'workspace'),
        ...extraSections,
        howItRuns(template.runs),
      ],
    };
  }

  const name = trimmed(parsed.name);
  if (!name) return { problem: 'a new server needs a name' };
  const runs = object(parsed.runs) as ServerRuns;
  const problems = serverProblems({ name, runs, offer: extras.offer, omit: extras.omit }, known.servers);
  if (problems.length > 0) return { problem: problems.join('; ') };
  return {
    proposal: { name, runs, ...extras, agents: agents ?? [], why },
    summary: `add the MCP server ${name}${agents?.length ? ` for ${agents.join(', ')}` : ''}`,
    sections: [
      section('What it is', [text(`${name} · new server · ${where(runs)}`), ...(extras.summary ? [text(extras.summary)] : []), text('Its tools are captured as soon as it is added.')]),
      ...whoGets(name, runs.where === 'workspace'),
      ...extraSections,
      howItRuns(runs),
    ],
  };
}
