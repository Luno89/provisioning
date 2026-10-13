import { describe, it, expect } from 'vitest';
import { draftServerProposal, type ProposalKnown } from './mcp-proposals.js';
import { runsFingerprint, type McpServerRecord, type ServerRuns } from './mcp-servers.js';
import { MCP_SERVER_TEMPLATES } from '../extensions/mcp/templates.js';

const HOSTED: ServerRuns = { where: 'hosted', url: 'http://docs.test/mcp' };
const docs: McpServerRecord = {
  id: 's1', ownerId: 'u1', name: 'docs', runs: HOSTED, createdAt: 't', updatedAt: 't',
  captured: { tools: [{ name: 'search' }], at: 't', fingerprint: runsFingerprint(HOSTED) },
};

const known = (over: Partial<ProposalKnown> = {}): ProposalKnown => ({
  servers: [docs],
  templates: MCP_SERVER_TEMPLATES,
  agents: [{ slug: 'koala' }, { slug: 'executor', servers: ['docs'] }, { slug: 'planner' }],
  ...over,
});

describe('a proposed MCP server', () => {
  it('adds a known server with the person\'s notes, given to the agents named, saying what installs it and what rebuilds', () => {
    const drafted = draftServerProposal({ template: 'playwright', agents: ['executor'], notes: 'Odoo is at http://localhost:8069.', why: 'stories need to check pages in Odoo' }, known());
    if ('problem' in drafted) throw new Error(drafted.problem);
    expect(drafted.proposal).toEqual({ template: 'playwright', name: 'playwright', notes: 'Odoo is at http://localhost:8069.', agents: ['executor'], why: 'stories need to check pages in Odoo' });
    expect(drafted.summary).toBe('add the MCP server playwright and give it to executor');
    expect(drafted.detail).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Server: playwright, the known playwright server — A headless Chromium/),
      'Runs in the workspace (node)',
      expect.stringMatching(/^Install with npm: @playwright\/mcp@/),
      'Notes: Odoo is at http://localhost:8069.',
      'Given to: executor (each one\'s image rebuilds with it)',
      'Why: stories need to check pages in Odoo',
    ]));
  });

  it('gives a server the person has to the agents not holding it yet, and changes nothing else about it', () => {
    const drafted = draftServerProposal({ server: 'docs', agents: ['executor', 'planner'], why: 'planning needs the docs' }, known());
    if ('problem' in drafted) throw new Error(drafted.problem);
    expect(drafted.proposal).toEqual({ server: 'docs', name: 'docs', agents: ['planner'], why: 'planning needs the docs' });
    expect(drafted.detail).toEqual(['Server: docs — captured, 1 tool offered: search', 'Given to: planner', 'Why: planning needs the docs']);

    expect(draftServerProposal({ server: 'docs', agents: ['executor'], why: 'w' }, known())).toEqual({ problem: 'executor already holds docs' });
    expect(draftServerProposal({ server: 'docs', agents: ['planner'], notes: 'n', why: 'w' }, known())).toEqual({ problem: 'a server you already have is changed on its page in the Studio; propose only who should hold it' });
  });

  it('adds a new one only when it makes sense', () => {
    const runs = { where: 'hosted', url: 'http://tickets.test/mcp' };
    const drafted = draftServerProposal({ name: 'tickets', runs: JSON.stringify(runs), agents: '["koala"]', why: 'w' }, known());
    expect(drafted).toMatchObject({ proposal: { name: 'tickets', runs, agents: ['koala'] }, detail: expect.arrayContaining(['Runs hosted at http://tickets.test/mcp']) });

    expect(draftServerProposal({ name: 'Tickets!', runs, why: 'w' }, known())).toMatchObject({ problem: expect.stringMatching(/^the name has to be/) });
    expect(draftServerProposal({ name: 'tickets', runs: { where: 'hosted', url: 'ftp://x' }, why: 'w' }, known())).toEqual({ problem: 'a hosted server\'s URL has to be http or https' });
    expect(draftServerProposal({ name: 'docs', runs, why: 'w' }, known())).toEqual({ problem: 'you already have a server called docs' });
  });

  it('refuses what it cannot tell apart, what does not exist, a template already added, and no reason', () => {
    expect(draftServerProposal({ template: 'playwright', server: 'docs', why: 'w' }, known())).toEqual({ problem: 'propose one thing: a server you already have (server), a known one (template), or a new one (name and runs)' });
    expect(draftServerProposal({ template: 'selenium', why: 'w' }, known())).toEqual({ problem: 'there is no known server called "selenium"; known ones are playwright' });
    expect(draftServerProposal({ server: 'gitea', agents: ['koala'], why: 'w' }, known())).toEqual({ problem: 'there is no MCP server called "gitea"; list_mcp_servers shows the ones there are' });
    expect(draftServerProposal({ template: 'playwright', agents: ['ghost'], why: 'w' }, known())).toEqual({ problem: 'there is no agent called "ghost"' });
    expect(draftServerProposal({ template: 'playwright' }, known())).toEqual({ problem: 'say why, shown to the person on the card' });
    const added = { ...docs, id: 's2', name: 'browser', from: { template: 'playwright' } };
    expect(draftServerProposal({ template: 'playwright', why: 'w' }, known({ servers: [docs, added] }))).toEqual({ problem: 'playwright is already added, as browser; propose server: "browser" to give it to agents' });
  });
});
