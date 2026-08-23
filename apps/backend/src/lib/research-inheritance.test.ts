/**
 * The research sub-agent runs inside a persona's turn, and was the one agent that ignored it.
 *
 * Invisible without a live model: it produced findings either way, just sampled under the shipped
 * defaults instead of whatever the persona had been tuned to.
 */
import { describe, it, expect, vi } from 'vitest';
import { runResearchAgent } from './research-agent.js';

/** Captures the request body, then ends the loop by answering in prose. */
function capture() {
  const bodies: any[] = [];
  // The agent streams, so it reads text() rather than json(). One content chunk and no tool call
  // ends the loop on the first round.
  const sse = [
    'data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":5}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const impl = vi.fn(async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, text: async () => sse } as any;
  });
  return { impl: impl as unknown as typeof fetch, bodies };
}

const run = (overrides?: Record<string, unknown>) => {
  const { impl, bodies } = capture();
  return runResearchAgent({
    question: 'q', baseUrl: 'http://m', kind: 'tabbyapi',
    webSearch: async () => ({ hits: [], unavailable: false, answeredBy: 'searxng' as const }), fetchWebPage: async () => '',
    fetchImpl: impl, ...(overrides ? { overrides } : {}),
  }).then(() => bodies[0]);
};

describe('what the research sub-agent runs under', () => {
  it('inherits the caller\'s sampling', async () => {
    // A persona tuned for a model should not have half its turn run under different settings.
    const body = await run({ temperature: 0.15, top_p: 0.8 });

    expect(body.temperature).toBe(0.15);
    expect(body.top_p).toBe(0.8);
  });

  it('keeps reasoning off even when the persona asks for it', async () => {
    /**
     * A FLOOR, not a default. This is a dispatch loop whose only useful output is a tool call, and
     * reasoning talks the model out of emitting one — the same failure measured on the authoring
     * route, which produced 16,664 characters of deliberation and no answer.
     */
    const body = await run({ think: true });

    expect(body.template_vars).toMatchObject({ enable_thinking: false });
    expect(body.think).toBeUndefined();
  });

  it('still runs with no inherited config at all', async () => {
    const body = await run();

    expect(body.template_vars).toMatchObject({ enable_thinking: false });
    expect(body.messages).toBeTruthy();
  });

  it('never lets an inherited knob reach a transport field', async () => {
    // maxSteps is read by a loop, not sent. The registry decides; the caller's bag does not.
    const body = await run({ maxSteps: 99 });
    expect(body.maxSteps).toBeUndefined();
  });
});
