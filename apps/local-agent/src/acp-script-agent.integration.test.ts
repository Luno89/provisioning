import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { callMcp, turnFor, type AgentScript } from './acp-script-agent.js';

const script: AgentScript = { name: 's', version: '1', turns: [
  { steps: [{ say: 'first' }] },
  { when: 'Question:', steps: [{ say: 'yes' }] },
  { steps: [{ say: 'second' }] },
] };

describe('which turn a scripted agent plays', () => {
  it('plays the turn whose prompt it was written for, and the rest in order', () => {
    expect(turnFor(script, 0, 'Question: does it pass?')?.steps).toEqual([{ say: 'yes' }]);
    expect(turnFor(script, 0, 'Do the task')?.steps).toEqual([{ say: 'first' }]);
    expect(turnFor(script, 1, 'Do the next')?.steps).toEqual([{ say: 'second' }]);
    expect(turnFor(script, 2, 'Anything more')).toBeUndefined();
  });

  it('takes a turn whose phrases are all in what was asked, in the order the turns are listed', () => {
    const script: AgentScript = { name: 's', version: '1', turns: [
      { when: ['Question:', 'met'], steps: [{ say: 'yes' }] },
      { when: 'Question:', steps: [{ say: 'no' }] },
    ] };
    expect(turnFor(script, 0, 'Question: the verdict says met')?.steps).toEqual([{ say: 'yes' }]);
    expect(turnFor(script, 0, 'Question: the verdict says nothing')?.steps).toEqual([{ say: 'no' }]);
  });
});

describe('a scripted agent calling a tool that answers with a job', () => {
  it('follows the job with wait_for until it has the result, as a real agent is told to', async () => {
    const job = '0b5c6a3e-2f4d-4c7a-9e1b-7d2f8a9c0e11';
    const asked: { name: string; args: unknown }[] = [];
    const answers = [
      `research is still running in Koala as job ${job}. Call wait_for with job "${job}" to get its result; do not call research again for it.`,
      `job ${job} is still running in Koala; call wait_for with it again.`,
      'The header is Axial Concepts.',
    ];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const { id, params } = JSON.parse(body) as { id: number; params: { name: string; arguments: unknown } };
        asked.push({ name: params.name, args: params.arguments });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: answers.shift() }] } }));
      });
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    try {
      const said = await callMcp([{ name: 'koala', url }], { server: 'koala', tool: 'research', args: { question: 'header?' }, follow: true }, 1);
      expect(said).toBe(`research: The header is Axial Concepts. (waited for job ${job} 2 times)`);
      expect(asked).toEqual([
        { name: 'research', args: { question: 'header?' } },
        { name: 'wait_for', args: { job } },
        { name: 'wait_for', args: { job } },
      ]);
      answers.push(`research is still running in Koala as job ${job}. Call wait_for with job "${job}" to get its result; do not call research again for it.`);
      expect(await callMcp([{ name: 'koala', url }], { server: 'koala', tool: 'research', args: {} }, 2)).toContain('still running');
    } finally {
      server.close();
    }
  });
});
