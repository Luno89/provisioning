import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import axios from 'axios';
import Lab from '../components/Lab';

/**
 * Captures the socket handlers Lab registers, so a test can push a frame the way the server would.
 *
 * The shared mock in test/setup.ts returns a bare stub; this replaces `on` with a recorder while
 * keeping the rest, so the live view can be driven without a server.
 */
const handlers = new Map<string, (payload: any) => void>();
const mockSocket = () => {
  handlers.clear();
  vi.mocked(io).mockReturnValue({
    on: (event: string, fn: (payload: any) => void) => { handlers.set(event, fn); },
    emit: vi.fn(),
    disconnect: vi.fn(),
    off: vi.fn(),
  } as any);
};
const push = (event: string, payload: unknown) =>
  act(() => { handlers.get(event)?.(payload); });

const agentStep = (over: Record<string, unknown> = {}) => ({
  step: 1, toolCalls: [{ name: 'run_command', arguments: '{"command":"ls /work"}' }],
  toolResults: [{ name: 'run_command', result: '{"exitCode":0,"stdout":"a.js"}' }],
  tokens: 320, ...over,
});

/**
 * Wiring tests for the Lab.
 *
 * The one that matters is `verified` vs `claimed`: an agent's self-report is the least reliable
 * number in a run, so the UI must show them separately and flag a variant that claimed success
 * while its verify command failed. A table that quietly showed only `succeeded` would present the
 * exact failure the Lab exists to catch as a pass.
 */
vi.mock('axios');
const mockedAxios = vi.mocked(axios);

const config = {
  sections: [{
    id: 'agent', title: 'Agent loop', summary: 'one turn at a time',
    settings: [{ label: 'Max steps', value: '24', note: 'each step is an inference pass', source: 'lib/sandbox-tools.ts' }],
  }],
  prompts: [
    { id: 'plan', title: 'Plan mode', text: 'YOU ARE PLANNING' },
    { id: 'agent', title: 'Agent system prompt', text: 'GENERATED AGENT PROMPT with sandbox facts' },
  ],
  languages: [{ id: 'node', image: 'ubi9/nodejs-22', summary: 'Node 22' }],
  limits: { maxVariants: 6, maxRepeats: 5, maxTaskChars: 8000, maxTasks: 10, maxTotalRuns: 60 },
  // What the agent actually runs with — distinct from the registry's built-in default.
  effective: [
    { key: 'temperature', label: 'Temperature', group: 'sampling', value: 0.9, source: 'adopted', sourceFile: 'lib/sampling.ts' },
    { key: 'think', label: 'Reasoning on dispatch turns', group: 'sampling', value: false, source: 'harness', sourceFile: 'lib/sampling.ts' },
  ],
  // Served by the backend from its registry, so the picker can only offer knobs it can send.
  tunables: [
    { key: 'think', label: 'Reasoning on dispatch turns', group: 'sampling', type: 'boolean',
      placement: 'template_vars', field: 'enable_thinking',
      default: false, suggested: [false, true], source: 'lib/sampling.ts',
      note: 'Off by default. With reasoning on a dispatch turn can spend its whole budget deliberating.' },
    { key: 'temperature', label: 'Temperature', group: 'sampling', type: 'number', placement: 'body',
      min: 0, max: 2, step: 0.05, default: 0.3, suggested: [0.2, 0.7], source: 'lib/sampling.ts',
      note: 'Choosing a tool is not a creative act.' },
    { key: 'dry_multiplier', label: 'DRY multiplier', group: 'sampling', type: 'number', placement: 'body',
      engine: 'tabbyapi', default: 0.8, suggested: [0, 0.8], source: 'lib/sampling.ts',
      note: 'Penalises repeated SEQUENCES.' },
    { key: 'maxSteps', label: 'Max steps', group: 'loop', type: 'number', placement: 'loop',
      min: 1, max: 64, default: 24, suggested: [8, 16], source: 'lib/sandbox-tools.ts',
      note: 'Each step is a full inference pass plus a command.' },
    // No `suggested`, so it is sendable but not a one-click axis.
    { key: 'seed', label: 'Seed', group: 'sampling', type: 'number', source: 'lib/tunables.ts' },
    // Choices are filled in per request from what the caller can reach, never authored statically.
    { key: 'model', label: 'Model', group: 'loop', type: 'string', placement: 'loop',
      source: 'services/ModelService.ts', choicesFrom: 'models',
      choices: [
        { value: 'dep-1', label: 'Tabbyapi Production', note: 'Qwen3-32B · tabbyapi' },
        { value: 'end-1', label: 'Workstation', note: 'llama-3.1-8b · endpoint' },
      ] },
    { key: 'systemPrompt', label: 'System prompt (full replace)', group: 'prompt', type: 'string',
      placement: 'loop', source: 'lib/sandbox-tools.ts', promptId: 'agent',
      note: 'Replaces the generated prompt entirely, including the environment description.' },
    { key: 'extraInstructions', label: 'Extra instructions', group: 'prompt', type: 'string',
      placement: 'loop', source: 'lib/sandbox-tools.ts' },
  ],
};

const result = (over: Record<string, unknown> = {}) => ({
  label: 'think=false', taskId: 't1', succeeded: true, verified: true, verifyExitCode: 0,
  verifyOutput: 'PASS', steps: 5, tokensUsed: 1000, durationMs: 30000,
  summary: 'did the thing', transcript: ['npm test'],
  ...over,
});

const task = (id: string, name = id) => ({
  id, name, prompt: `do ${id}`, verifyCommand: 'node test.js',
});

const experiment = (over: Record<string, unknown> = {}) => ({
  id: 'exp-1', name: 'reasoning on/off',
  tasks: [task('t1', 'fib')],
  language: 'node', variants: [{ label: 'think=false', overrides: {} }], repeats: 1,
  status: 'complete', results: [], createdAt: '2026-08-03T00:00:00Z', ...over,
});

/** A run of a named task by a named variant. */
const run = (taskId: string, label: string, verified: boolean, over: Record<string, unknown> = {}) =>
  result({ taskId, label, verified, succeeded: verified, ...over });

const preview = {
  standing: { label: 'think=true', verified: 4, runs: 4, tasks: 2, rank: 1, wasBest: true, behindBy: 0, medianTokens: 5000 },
  changes: [{ key: 'think', label: 'Reasoning on dispatch turns', from: undefined, to: true }],
};

/**
 * The list serves summaries; the detail route serves the evidence.
 *
 * The fixtures are full records, and the client reads only summary fields off the list — which is
 * the real contract, since a full record is structurally a superset of a summary. What the mock
 * must get right is that expanding anything goes to `/harness/experiments/:id`, because that split
 * is the whole point of the change.
 */
const mockApi = (
  experiments: any[] = [],
  over: { profile?: unknown; preview?: unknown; config?: unknown } = {},
) => {
  mockedAxios.get.mockImplementation((url: string) => {
    if (url.includes('/harness/config')) return Promise.resolve({ data: over.config ?? config });
    if (url.includes('/harness/profile/preview')) return Promise.resolve({ data: over.preview ?? preview });
    if (url.includes('/harness/profile')) return Promise.resolve({ data: over.profile ?? null });
    const detail = /\/harness\/experiments\/(.+)$/.exec(url);
    if (detail) {
      return Promise.resolve({ data: experiments.find((e) => e.id === detail[1]) ?? null });
    }
    return Promise.resolve({ data: experiments });
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSocket();
  mockApi();
  mockedAxios.post.mockResolvedValue({ data: {} });
  mockedAxios.delete.mockResolvedValue({ data: {} });
  mockedAxios.put.mockResolvedValue({ data: {} });
});

/**
 * The Lab is two tabs now, and each experiment card is a tab strip.
 *
 * Configuration and experiments are asked about at different moments, so they no longer share one
 * scroll — which means a test that wants the settings has to say so, exactly as a person does.
 */
const harnessTab = async () => fireEvent.click(await screen.findByRole('button', { name: /^Harness$/ }));
const cardTab = async (name: RegExp | string) =>
  fireEvent.click(await screen.findByRole('button', { name }));

const renderLab = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><Lab apiBase="/api" socketUrl="http://localhost:3001" /></QueryClientProvider>,
  );
};

describe('the configuration surface', () => {
  it('shows live settings with the reason they are set that way', async () => {
    renderLab();
    await harnessTab();
    await waitFor(() => expect(screen.getByText('Max steps')).toBeInTheDocument());
    expect(screen.getByText('24')).toBeInTheDocument();
    // The note is why the value is what it is — the most useful thing on the page.
    expect(screen.getByText(/each step is an inference pass/)).toBeInTheDocument();
    expect(screen.getByText('lib/sandbox-tools.ts')).toBeInTheDocument();
  });

  it('shows a prompt verbatim when expanded, rather than describing it', async () => {
    renderLab();
    await harnessTab();
    await waitFor(() => expect(screen.getByText('Plan mode')).toBeInTheDocument());
    expect(screen.queryByText('YOU ARE PLANNING')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Plan mode'));
    expect(screen.getByText('YOU ARE PLANNING')).toBeInTheDocument();
  });
});

/** The suite-total row for a variant, which is the first place its label appears. */
const summaryRow = (label: string) => screen.getAllByText(label)[0]!.closest('tr')!;

describe('results', () => {
  it('reports verified separately from what the agent claimed', async () => {
    mockApi([experiment({ results: [result()] })]);
    renderLab();
    await waitFor(() => expect(screen.getByText('Verified')).toBeInTheDocument());
    expect(within(summaryRow('think=false')).getAllByText('1/1')).toHaveLength(2);
  });

  it('flags a variant that claimed success but failed verification', async () => {
    // The failure the Lab exists to catch: work marked done that never happened.
    mockApi([experiment({ results: [result({ succeeded: true, verified: false, verifyExitCode: 1 })] })]);
    renderLab();
    await waitFor(() => expect(screen.getByText('Verified')).toBeInTheDocument());
    const row = summaryRow('think=false');
    expect(within(row).getByText('0/1')).toBeInTheDocument();   // verified
    expect(within(row).getByText(/1\/1/)).toBeInTheDocument();  // claimed
  });

  it('opens a task/variant cell to show the verify output and what was run', async () => {
    mockApi([experiment({ results: [result({ verifyOutput: 'assertion failed', verifyExitCode: 1, verified: false })] })]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/think=false — 0 of 1 verified/));
    await waitFor(() => expect(screen.getByText(/assertion failed/)).toBeInTheDocument());
    expect(screen.getByText(/npm test/)).toBeInTheDocument();
  });

  it('leaves a run that never completed out of the medians, and says so', async () => {
    // Zeros from a run that never started would make the variant look cheaper for having failed.
    mockApi([experiment({
      results: [
        result({ steps: 10, tokensUsed: 5000 }),
        result({ steps: 0, tokensUsed: 0, error: 'Model call failed (502)', succeeded: false, verified: false }),
      ],
    })]);
    renderLab();
    await waitFor(() => expect(screen.getByText(/didn't run/)).toBeInTheDocument());
    const row = summaryRow('think=false');
    expect(within(row).getByText('10')).toBeInTheDocument();
    expect(within(row).getByText('5,000')).toBeInTheDocument();
  });

  it('shows a run that could not complete as an error, not a failed task', async () => {
    mockApi([experiment({ results: [result({ error: 'Model call failed (502)', succeeded: false, verified: false })] })]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/think=false — 0 of 1 verified/));
    await waitFor(() => expect(screen.getByText(/Model call failed \(502\)/)).toBeInTheDocument());
  });
});

describe('the task matrix', () => {
  const suite = {
    tasks: [task('t1', 'fib'), task('t2', 'parse csv')],
    variants: [{ label: 'a', overrides: {} }, { label: 'b', overrides: {} }],
  };

  it('shows which tasks a variant won, not just how many', async () => {
    // The whole reason a suite is worth its GPU time: both variants sit at 1/2 overall, and
    // reporting only that would call the setting a dead heat when it changed which tasks succeed.
    mockApi([experiment({
      ...suite,
      results: [
        run('t1', 'a', true), run('t1', 'b', false),
        run('t2', 'a', false), run('t2', 'b', true),
      ],
    })]);
    renderLab();

    await waitFor(() => expect(screen.getByText('fib')).toBeInTheDocument());
    // Verified and claimed both read 1/2 for both variants — the dead heat the matrix disproves.
    expect(within(summaryRow('a')).getAllByText('1/2')).toHaveLength(2);
    expect(within(summaryRow('b')).getAllByText('1/2')).toHaveLength(2);

    const fibRow = screen.getByText('fib').closest('tr')!;
    expect(within(fibRow).getByTitle(/^a —/)).toHaveTextContent('1/1');
    expect(within(fibRow).getByTitle(/^b —/)).toHaveTextContent('0/1');
  });

  it('marks a task nothing distinguished, which bought no evidence', async () => {
    mockApi([experiment({ ...suite, results: [run('t1', 'a', true), run('t1', 'b', true)] })]);
    renderLab();
    await waitFor(() => expect(screen.getByText(/no signal — all tied/)).toBeInTheDocument());
  });

  it('calls out a task every variant failed, since that is usually the task', async () => {
    mockApi([experiment({ ...suite, results: [run('t1', 'a', false), run('t1', 'b', false)] })]);
    renderLab();
    await waitFor(() => expect(screen.getByText(/every variant failed/)).toBeInTheDocument());
  });

  it('does not judge a task the run has not reached yet', async () => {
    // Mid-experiment the second variant has no results. Reading its empty cell as agreement would
    // report a verdict on a task measured once.
    mockApi([experiment({ ...suite, results: [run('t1', 'a', true)], status: 'running', running: true })]);
    renderLab();
    await waitFor(() => expect(screen.getByText('fib')).toBeInTheDocument());
    expect(screen.queryByText(/no signal/)).not.toBeInTheDocument();
    expect(within(screen.getByText('fib').closest('tr')!).getByTitle('not run yet')).toBeInTheDocument();
  });

  it('renders an experiment created before suites existed', async () => {
    // Those runs were stored with no taskId at all. Both the list and the detail route resolve it
    // to the synthetic task now, so this fixture is what the client actually receives — and the
    // client no longer carries a copy of that id to do the joining itself.
    mockApi([{
      id: 'old', name: 'legacy', task: 'write fib', verifyCommand: 'node t.js', language: 'node',
      tasks: [{ id: 'task', name: 'Task' }],
      variants: [{ label: 'think=false', overrides: {} }], repeats: 1, status: 'complete',
      createdAt: '2026-08-01T00:00:00Z',
      results: [{ ...result(), taskId: 'task' }],
    }]);
    renderLab();
    // The synthetic single task appears in the matrix, scored, rather than as an orphaned run.
    await waitFor(() => expect(screen.getByTitle(/think=false — 1 of 1 verified/)).toBeInTheDocument());
    expect(within(summaryRow('think=false')).getAllByText('1/1')).toHaveLength(2);
  });
});

describe('promoting a winning configuration', () => {
  it('shows what adopting it would actually change, before applying', async () => {
    // "Promote" on a variant labelled think=true sounds like one thing, and once a profile has
    // accumulated a few promotions it rarely is.
    mockApi([experiment({ results: [result()] })]);
    renderLab();
    fireEvent.click(await screen.findByText('Promote'));
    expect(await screen.findByText(/Reasoning on dispatch turns/)).toBeInTheDocument();
    expect(screen.getByText('default')).toBeInTheDocument();
    expect(screen.getByText(/verified 4\/4 across 2 tasks/)).toBeInTheDocument();
  });

  it('warns when the variant did not win, since adopting a loser must be deliberate', async () => {
    mockApi([experiment({ results: [result()] })], {
      preview: {
        standing: { label: 'a', verified: 1, runs: 4, tasks: 2, rank: 2, wasBest: false, behindBy: 0.5, medianTokens: 100 },
        changes: [{ key: 'think', label: 'Reasoning on dispatch turns', from: true, to: false }],
      },
    });
    renderLab();
    fireEvent.click(await screen.findByText('Promote'));
    expect(await screen.findByText(/It placed 2, behind the best by 50 points/)).toBeInTheDocument();
  });

  it('posts the promotion when confirmed', async () => {
    mockApi([experiment({ results: [result()] })]);
    renderLab();
    fireEvent.click(await screen.findByText('Promote'));
    fireEvent.click(await screen.findByText('Adopt'));
    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledWith(
      '/api/harness/profile/promote',
      { experimentId: 'exp-1', label: 'think=false' },
      expect.anything(),
    ));
  });

  it('will not adopt a configuration that changes nothing', async () => {
    mockApi([experiment({ results: [result()] })], {
      preview: { standing: preview.standing, changes: [] },
    });
    renderLab();
    fireEvent.click(await screen.findByText('Promote'));
    expect(await screen.findByText(/already matches the defaults/)).toBeInTheDocument();
    expect(screen.getByText('Adopt')).toBeDisabled();
  });

  it('offers no promotion for a variant that never ran', async () => {
    // Promoting on no evidence is what this whole surface exists to prevent.
    mockApi([experiment({ results: [] })]);
    renderLab();
    await screen.findByText('reasoning on/off');
    expect(screen.queryByText('Promote')).not.toBeInTheDocument();
  });

  it('shows the adopted defaults with the experiment that earned them', async () => {
    mockApi([], {
      profile: {
        overrides: { think: true, temperature: 0.2 },
        from: {
          experimentId: 'exp-1', experimentName: 'reasoning on/off', variantLabel: 'think=true',
          verified: 4, runs: 4, tasks: 2, wasBest: true, promotedAt: '2026-08-04T00:00:00Z',
        },
        updatedAt: '2026-08-04T00:00:00Z',
      },
    });
    renderLab();
    await harnessTab();
    const banner = (await screen.findByText('Adopted defaults')).closest('div')!;
    // The values in force, and the evidence, together — a default that cannot explain itself is
    // an unexplained number six months later. `think=true` appears twice in here, as a value and
    // as the variant label that earned it, which is the point rather than a duplicate.
    expect(within(banner).getAllByText('think=true')).toHaveLength(2);
    expect(within(banner).getByText('temperature=0.2')).toBeInTheDocument();
    expect(within(banner).getByText(/verified 4\/4 across 2 tasks/)).toBeInTheDocument();
  });

  it('says so on the banner when the adopted variant lost its experiment', async () => {
    mockApi([], {
      profile: {
        overrides: { think: true },
        from: {
          experimentId: 'e', experimentName: 'x', variantLabel: 'think=true',
          verified: 1, runs: 4, tasks: 2, wasBest: false, promotedAt: '2026-08-04T00:00:00Z',
        },
        updatedAt: '2026-08-04T00:00:00Z',
      },
    });
    renderLab();
    await harnessTab();
    expect(await screen.findByText(/did not win its experiment/)).toBeInTheDocument();
  });
});

describe('what the model was actually sent', () => {
  const withRequest = result({
    verified: false, succeeded: false, verifyExitCode: 1, verifyOutput: 'no PASS',
    expected: { verifyCommand: 'node hello.js | grep -q PASS', note: 'Verified when this exits 0.' },
    request: {
      systemPrompt: 'YOU ARE AN AGENT. There is NO outbound network.',
      kickoff: 'Begin. Start by looking at what is in the workspace.',
      model: 'qwen3',
      tools: [{ name: 'run_command', description: 'Run a shell command in the sandbox.' }],
      parameters: { temperature: 0.7, max_tokens: 800, template_vars: { enable_thinking: false } },
      overrides: { temperature: 0.7, dry_multiplier: 0.8 },
      unsupported: ['dry_multiplier'],
      loop: { maxSteps: 24, think: false, toolResultCap: 8000 },
    },
  });

  it('shows the prompt that produced the run', async () => {
    // A score without its input is a claim nobody can check. An entire session of experiments here
    // failed on the system prompt, and no record contained it.
    mockApi([experiment({ results: [withRequest] })]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/think=false — 0 of 1 verified/));
    fireEvent.click(await screen.findByText(/Sent to the model/));
    expect(await screen.findByText(/YOU ARE AN AGENT/)).toBeInTheDocument();
    expect(screen.getByText(/Begin\. Start by looking/)).toBeInTheDocument();
  });

  it('says where each knob got its value, which JSON alone cannot', async () => {
    // A value can be present because the harness defaults to it or because a variant overrode it,
    // and a knob can be absent because nobody set it or because it was dropped for the wrong
    // engine. Those look identical in a request body and mean completely different things.
    mockApi([experiment({ results: [withRequest] })]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/think=false — 0 of 1 verified/));
    fireEvent.click(await screen.findByText(/Sent to the model/));

    const temp = (await screen.findByText('temperature')).closest('tr')!;
    expect(within(temp).getByText('0.7')).toBeInTheDocument();
    expect(within(temp).getByText('override')).toBeInTheDocument();

    // Asked for, never sent — the failure the registry exists to make visible.
    const dry = screen.getByText('dry_multiplier').closest('tr')!;
    expect(within(dry).getByText(/DROPPED/)).toBeInTheDocument();

    // Loop controls are real knobs even though they never go on the wire.
    expect(screen.getByText('maxSteps')).toBeInTheDocument();
    expect(screen.getByText('maxToolResultChars')).toBeInTheDocument();
  });

  it('shows the tool descriptions the model actually read', async () => {
    mockApi([experiment({ results: [withRequest] })]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/think=false — 0 of 1 verified/));
    fireEvent.click(await screen.findByText(/Sent to the model/));
    expect(await screen.findByText(/Tools offered \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Run a shell command in the sandbox/)).toBeInTheDocument();
  });

  it('puts the expected result beside the actual one', async () => {
    mockApi([experiment({ results: [withRequest] })]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/think=false — 0 of 1 verified/));
    expect(await screen.findByText(/node hello\.js \| grep -q PASS/)).toBeInTheDocument();
    expect(screen.getByText(/→ exit 0/)).toBeInTheDocument();
    expect(screen.getByText(/actual \(exit 1\)/)).toBeInTheDocument();
  });

  it('shows the whole exchange verbatim, roles and all', async () => {
    // The trace is a reconstruction whose tool results are clipped shorter than what the model was
    // actually sent — so it reads as a record while misrepresenting what the model saw.
    mockApi([experiment({ results: [result({
      verified: false, succeeded: false, verifyExitCode: 1,
      conversation: [
        { role: 'system', content: 'YOU ARE AN AGENT. There is NO outbound network.' },
        { role: 'user', content: 'Begin. Start by looking at what is in the workspace.' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'run_command', arguments: '{"command":"ls /work"}' }] },
        { role: 'tool', content: '{"exitCode":0,"stdout":"hello.js"}', toolCallId: 'c1', name: 'run_command' },
      ],
    })] })]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/think=false — 0 of 1 verified/));
    fireEvent.click(await screen.findByText(/Full conversation · 4 messages/));

    expect(await screen.findByText('system')).toBeInTheDocument();
    expect(screen.getByText('tool')).toBeInTheDocument();
    expect(screen.getByText(/YOU ARE AN AGENT/)).toBeInTheDocument();
    // The tool result as the model received it — the thing the trace does not show faithfully.
    expect(screen.getByText(/"stdout":"hello.js"/)).toBeInTheDocument();
    expect(screen.getByText(/"command":"ls \/work"/)).toBeInTheDocument();
  });

  it('marks a message that was shortened, so it never reads as complete', async () => {
    mockApi([experiment({ results: [result({
      verified: false, succeeded: false,
      conversation: [{ role: 'tool', content: 'x'.repeat(50), truncated: true }],
    })] })]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/think=false — 0 of 1 verified/));
    fireEvent.click(await screen.findByText(/Full conversation/));
    expect(await screen.findByText('truncated')).toBeInTheDocument();
  });

  it('still renders a run recorded before requests were captured', async () => {
    mockApi([experiment({ results: [result({ verified: false, succeeded: false })] })]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/think=false — 0 of 1 verified/));
    await waitFor(() => expect(screen.getByText('did the thing')).toBeInTheDocument());
    expect(screen.queryByText(/Sent to the model/)).not.toBeInTheDocument();
  });
});

describe('watching a run live', () => {
  const started = {
    experimentId: 'exp-1', taskId: 't1', taskName: 'fib', label: 'think=false', done: 1, total: 2,
  };

  it('shows each step as it lands, with the command and its exit code', async () => {
    // A progress counter cannot distinguish an agent working from one looping. Measured on the
    // suite this was built for: a variant sat at "running" for fifteen minutes and timed out.
    mockApi([experiment({ running: true, status: 'running' })]);
    renderLab();
    await screen.findByText('reasoning on/off');

    push('experiment-run-started', started);
    expect(await screen.findByText(/Waiting for the first step/)).toBeInTheDocument();

    push('experiment-step', { ...started, step: agentStep() });
    expect(await screen.findByText('run_command')).toBeInTheDocument();
    expect(screen.getByText(/ls \/work/)).toBeInTheDocument();
    expect(screen.getByText(/→ ok/)).toBeInTheDocument();
  });

  it('calls out a turn that produced no tool call, which a spinner hides', async () => {
    // The failure a dispatch loop is most vulnerable to.
    mockApi([experiment({ running: true, status: 'running' })]);
    renderLab();
    await screen.findByText('reasoning on/off');

    push('experiment-run-started', started);
    push('experiment-step', {
      ...started,
      step: agentStep({ step: 2, toolCalls: [], toolResults: [], reasoning: 'x'.repeat(4000) }),
    });
    expect(await screen.findByText(/no tool call — spent the turn reasoning/)).toBeInTheDocument();
  });

  it('ignores a late step belonging to a variant it is no longer showing', async () => {
    // Frames can arrive out of order around a handover, and one late step must not relabel the
    // panel onto a run that has already finished.
    mockApi([experiment({ running: true, status: 'running' })]);
    renderLab();
    await screen.findByText('reasoning on/off');

    push('experiment-run-started', started);
    push('experiment-step', { ...started, label: 'think=true', step: agentStep() });
    expect(screen.getByText(/Waiting for the first step/)).toBeInTheDocument();
  });

  it('clears the panel when the run lands, since the trace then owns the record', async () => {
    mockApi([experiment({ running: true, status: 'running' })]);
    renderLab();
    await screen.findByText('reasoning on/off');

    push('experiment-run-started', started);
    push('experiment-step', { ...started, step: agentStep() });
    expect(await screen.findByText('run_command')).toBeInTheDocument();

    push('experiment-run-finished', { experimentId: 'exp-1', taskId: 't1', label: 'think=false', verified: true });
    await waitFor(() => expect(screen.queryByText('run_command')).not.toBeInTheDocument());
  });
});

describe('the polled list stays small', () => {
  it('renders the matrix without fetching any experiment detail', async () => {
    // The regression this guards: the list used to carry every run's trace, and it is polled. One
    // six-run suite is about a megabyte, and history now persists, so the archive was being
    // re-sent every five seconds to render numbers it already had.
    mockApi([experiment({ results: [run('t1', 'think=false', true)] })]);
    renderLab();
    await waitFor(() => expect(screen.getByText('Verified')).toBeInTheDocument());
    expect(mockedAxios.get.mock.calls.map(([url]) => url))
      .not.toContain('/api/harness/experiments/exp-1');
  });

  it('fetches the detail only when a cell is opened', async () => {
    mockApi([experiment({ results: [run('t1', 'think=false', false)] })]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/think=false — 0 of 1 verified/));
    await waitFor(() => expect(mockedAxios.get.mock.calls.map(([url]) => url))
      .toContain('/api/harness/experiments/exp-1'));
  });

  it('stops polling once nothing is running', async () => {
    // A finished archive has nothing new to say, and the live panel carries progress over sockets.
    mockApi([experiment({ status: 'complete', results: [result()] })]);
    renderLab();
    await waitFor(() => expect(screen.getByText('Verified')).toBeInTheDocument());
    const listCalls = () => mockedAxios.get.mock.calls
      .filter(([url]) => url === '/api/harness/experiments').length;
    const before = listCalls();
    await new Promise((r) => setTimeout(r, 150));
    expect(listCalls()).toBe(before);
  });
});

describe('what each variant actually changes', () => {
  const suite = (over: Record<string, unknown> = {}) => experiment({
    variants: [
      { label: 'shipped-prompt', overrides: {} },
      { label: 'terse-prompt', overrides: { systemPrompt: 'You are terse and you call tools. /work is writable. There is no network. Call finish when done.' } },
      { label: 'with-extra', overrides: { extraInstructions: 'Prefer small commits.', temperature: 0.7 } },
    ],
    ...over,
  });

  it('shows a variant its own system prompt in full', async () => {
    // The overrides were on the wire all along and rendered nowhere: an experiment comparing
    // prompts could not show you the prompts.
    mockApi([suite()]);
    renderLab();
    await cardTab(/^Variants/);
    fireEvent.click(await screen.findByText('terse-prompt'));
    expect(await screen.findByText(/You are terse and you call tools/)).toBeInTheDocument();
  });

  it('shows the generated default for a variant that overrides nothing', async () => {
    // A control arm should be readable too, or "shipped-prompt" is a promise the UI never keeps.
    mockApi([suite()]);
    renderLab();
    await cardTab(/^Variants/);
    fireEvent.click(await screen.findByText('shipped-prompt'));
    // The generated prompt is what a non-overriding variant actually runs, and the row says so.
    expect(await screen.findByText(/GENERATED AGENT PROMPT/)).toBeInTheDocument();
    expect(screen.getAllByText('harness default').length).toBeGreaterThan(0);
  });

  it('shows appended instructions and other knobs separately', async () => {
    mockApi([suite()]);
    renderLab();
    await cardTab(/^Variants/);
    fireEvent.click(await screen.findByText('with-extra'));
    expect(await screen.findByText('Prefer small commits.')).toBeInTheDocument();
    // Rows come from the registry, so every declared knob is present whether set or not.
    expect(screen.getByText('temperature')).toBeInTheDocument();
    expect(screen.getByText('dry_multiplier')).toBeInTheDocument();
    // Both extraInstructions and temperature are set here, so two rows attribute to the variant.
    expect(screen.getAllByText('this variant')).toHaveLength(2);
  });

  it('is driven by the registry, not by a list of key names in the UI', async () => {
    // The panel used to know `systemPrompt` and `extraInstructions` by name and special-case them,
    // so it could only show knobs someone remembered to list — the same failure as the old axis
    // picker, a UI with its own private idea of what exists.
    mockApi([suite()]);
    renderLab();
    await cardTab(/^Variants/);
    fireEvent.click(await screen.findByText('shipped-prompt'));
    // getAllByText: a key also appears in the collapsed header of any variant that sets it.
    for (const key of ['systemPrompt', 'extraInstructions', 'temperature', 'maxSteps', 'seed']) {
      expect((await screen.findAllByText(key)).length).toBeGreaterThan(0);
    }
  });

  it('lets a variant be edited, with an editor chosen from the declared type', async () => {
    mockApi([suite()]);
    renderLab();
    await cardTab(/^Variants/);
    fireEvent.click(await screen.findByText('terse-prompt'));
    fireEvent.click(await screen.findByText('Edit variants'));

    const box = await screen.findByDisplayValue(/You are terse and you call tools/);
    fireEvent.change(box, { target: { value: 'Reworded prompt.' } });
    fireEvent.click(screen.getByText('Save variants'));

    await waitFor(() => expect(mockedAxios.put).toHaveBeenCalledWith(
      '/api/harness/experiments/exp-1',
      { variants: expect.arrayContaining([
        { label: 'terse-prompt', overrides: expect.objectContaining({ systemPrompt: 'Reworded prompt.' }) },
      ]) },
      expect.anything(),
    ));
  });

  it('warns when a promoted default supplies a value the variant is named against', async () => {
    // The failure that invalidated a real experiment: `shipped-prompt` silently ran a promoted
    // prompt, so two of three arms were identical.
    mockApi([suite()], {
      profile: { overrides: { systemPrompt: 'promoted terse prompt' }, updatedAt: 'x' },
    });
    renderLab();
    await cardTab(/^Variants/);
    // Exactly the two arms that do NOT set systemPrompt inherit the promoted one — which is how
    // a three-arm experiment quietly became a two-arm one.
    const warnings = await screen.findAllByText(/inherits systemPrompt from adopted defaults/);
    expect(warnings).toHaveLength(2);
    expect(screen.getByText('terse-prompt').closest('div'))
      .not.toHaveTextContent(/inherits systemPrompt/);
  });
});

describe('full-screen focus mode', () => {
  const focusable = () => experiment({
    tasks: [{
      id: 't1', name: 'fib', prompt: 'write fib', verifyCommand: 'node t.js',
      seed: [{ path: 'data.txt', content: 'test data' }],
      solution: [{ path: 'read.js', content: 'console.log(1)' }],
    }],
    variants: [{ label: 'terse', overrides: { temperature: 0.7 } }],
    results: [result({
      taskId: 't1', label: 'terse', verified: false, succeeded: false,
      conversation: [
        { role: 'system', content: 'YOU ARE AN AGENT.' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'run_command', arguments: '{"command":"ls"}' }] },
      ],
    })],
  });

  const openFocus = async () => {
    renderLab();
    fireEvent.click(await screen.findByTitle(/Open full screen/));
    // The shell renders before the detail fetch resolves, so wait for content that only exists
    // once it has — otherwise assertions race the empty first paint.
    await screen.findByDisplayValue('node t.js');
  };

  it('puts the verify definition, the prompt and the raw output on one screen', async () => {
    // Authoring means moving between these three repeatedly; in the card they are three tabs, so
    // every loop costs two clicks and the output that motivated the edit is never visible during it.
    mockApi([focusable()]);
    await openFocus();

    expect(await screen.findByText('Verify command')).toBeInTheDocument();
    expect(screen.getByText(/Seed — present before the agent starts/)).toBeInTheDocument();
    expect(screen.getByText(/Solution — reference answer/)).toBeInTheDocument();
    expect(screen.getByText('Prompt')).toBeInTheDocument();
    expect(screen.getByText('Model output')).toBeInTheDocument();
  });

  it('shows every knob as a raw editable value, with the default as the placeholder', async () => {
    // The view for someone who knows what dry_allowed_length does and wants to type 3.
    mockApi([focusable()]);
    await openFocus();
    fireEvent.click(screen.getByRole('button', { name: 'options' }));

    // Set on this variant, so it shows its literal value.
    expect(screen.getByDisplayValue('0.7')).toBeInTheDocument();
    // Unset, so the harness default reads as a placeholder rather than as a value.
    const think = screen.getByText('think').closest('tr')!;
    expect(within(think).getByPlaceholderText('false')).toBeInTheDocument();
  });

  it('shows the conversation verbatim rather than a summary', async () => {
    mockApi([focusable()]);
    await openFocus();
    expect(await screen.findByText(/YOU ARE AN AGENT/)).toBeInTheDocument();
    expect(screen.getByText(/run_command/)).toBeInTheDocument();
  });

  it('runs both halves of the gate without starting the experiment', async () => {
    mockApi([focusable()]);
    mockedAxios.post.mockResolvedValueOnce({
      data: { tasks: [{ ok: false, exitCode: 1, solutionExitCode: 1, reason: 'the command is wrong, not the task' }] },
    });
    await openFocus();
    fireEvent.click(screen.getByText('Check gate'));

    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledWith(
      '/api/harness/author/validate',
      { tasks: [expect.objectContaining({ id: 't1', seed: expect.any(Array) })] },
      expect.anything(),
    ));
    expect(await screen.findByText(/Gate rejected — seed-only exit 1, solution exit 1/)).toBeInTheDocument();
  });

  it('saves edited tasks and options together', async () => {
    mockApi([focusable()]);
    await openFocus();

    fireEvent.change(screen.getByDisplayValue('node t.js'), { target: { value: 'node other.js' } });
    fireEvent.click(screen.getByText('Save experiment'));

    await waitFor(() => expect(mockedAxios.put).toHaveBeenCalledWith(
      '/api/harness/experiments/exp-1',
      expect.objectContaining({
        tasks: [expect.objectContaining({ verifyCommand: 'node other.js' })],
      }),
      expect.anything(),
    ));
  });

  it('opens a real sandbox with the task seed applied', async () => {
    // The gate says whether a command failed; only a shell says why. And it must be the same
    // environment the run uses, or the command is being tested against the wrong thing.
    mockApi([focusable()]);
    mockedAxios.post.mockResolvedValueOnce({ data: { sessionId: 'wb-1' } });
    await openFocus();

    fireEvent.click(screen.getByText('open sandbox'));
    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledWith(
      '/api/harness/workbench/open',
      expect.objectContaining({ seed: [{ path: 'data.txt', content: 'test data' }] }),
      expect.anything(),
    ));
  });

  it('runs a command and shows its exit code', async () => {
    mockApi([focusable()]);
    mockedAxios.post.mockResolvedValueOnce({ data: { sessionId: 'wb-1' } });
    await openFocus();
    fireEvent.click(screen.getByText('open sandbox'));

    const box = await screen.findByPlaceholderText(/ls -la/);
    mockedAxios.post.mockResolvedValueOnce({
      data: { stdout: 'data.txt', stderr: '', exitCode: 0, timedOut: false },
    });
    fireEvent.change(box, { target: { value: 'ls' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(await screen.findByText('data.txt')).toBeInTheDocument();
    expect(screen.getByText('exit 0')).toBeInTheDocument();
  });

  it('treats a reaped session as expected rather than as a failure', async () => {
    // The idle reaper takes sessions, so a dead one is normal — and the button has to become
    // "open sandbox" again rather than leaving a prompt that cannot work.
    mockApi([focusable()]);
    mockedAxios.post.mockResolvedValueOnce({ data: { sessionId: 'wb-1' } });
    await openFocus();
    fireEvent.click(screen.getByText('open sandbox'));

    const box = await screen.findByPlaceholderText(/ls -la/);
    mockedAxios.post.mockRejectedValueOnce({ response: { data: { error: 'No such workbench session' } } });
    fireEvent.change(box, { target: { value: 'ls' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(await screen.findByText(/No such workbench session/)).toBeInTheDocument();
    expect(screen.getByText('open sandbox')).toBeInTheDocument();
  });

  it('proposes a task revision rather than applying it', async () => {
    // The model is suggesting a change to work you own, so the accept is where you read it.
    mockApi([focusable()]);
    await openFocus();
    fireEvent.click(screen.getByText('Koala'));

    const ask = await screen.findByPlaceholderText(/ask about this task/);
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        reply: 'The agent never sees that file — it needs to be seeded.',
        revision: { seed: [{ path: 'data.txt', content: 'hello' }] },
      },
    });
    fireEvent.change(ask, { target: { value: 'why does this fail?' } });
    fireEvent.keyDown(ask, { key: 'Enter' });

    expect(await screen.findByText(/never sees that file/)).toBeInTheDocument();
    expect(screen.getByText(/Proposed change to seed/)).toBeInTheDocument();
    // Nothing saved until it is accepted AND saved — two separate acts.
    expect(mockedAxios.put).not.toHaveBeenCalled();
  });

  it('applies an accepted revision to the editors without saving', async () => {
    mockApi([focusable()]);
    await openFocus();
    fireEvent.click(screen.getByText('Koala'));

    const ask = await screen.findByPlaceholderText(/ask about this task/);
    mockedAxios.post.mockResolvedValueOnce({
      data: { reply: 'Try this.', revision: { prompt: 'a reworded prompt' } },
    });
    fireEvent.change(ask, { target: { value: 'reword it' } });
    fireEvent.keyDown(ask, { key: 'Enter' });

    fireEvent.click(await screen.findByText('apply'));
    expect(await screen.findByDisplayValue('a reworded prompt')).toBeInTheDocument();
    expect(mockedAxios.put).not.toHaveBeenCalled();
  });

  it('closes on Escape, so a full-screen overlay is never a trap', async () => {
    mockApi([focusable()]);
    await openFocus();
    await screen.findByText('Verify command');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Verify command')).not.toBeInTheDocument());
  });
});

describe('editing a long value full screen', () => {
  const focusableLong = () => experiment({
    tasks: [{ id: 't1', name: 'fib', prompt: 'a short prompt', verifyCommand: 'node t.js' }],
    variants: [{ label: 'a', overrides: { systemPrompt: 'x'.repeat(400) } }],
  });

  /** Opens Focus and expands one field, leaving the editor on screen. */
  const openEditor = async (field: RegExp) => {
    mockApi([focusableLong()]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/Open full screen/));
    await screen.findByDisplayValue('node t.js');
    fireEvent.click(await screen.findByTitle(field));
  };

  it('expands a one-line table field into an editor that takes the left half', async () => {
    // A system prompt is 1,600 characters and the options table gives it one line, which is
    // unusable in the literal sense: you cannot see what you are changing. It opens beside the
    // model output rather than over it, so the text that prompted the edit stays readable.
    mockApi([focusableLong()]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/Open full screen/));
    await screen.findByDisplayValue('node t.js');
    fireEvent.click(screen.getByRole('button', { name: 'options' }));

    fireEvent.click(await screen.findByTitle(/Edit System prompt \(full replace\) in the full editor/));
    expect(await screen.findByText(/400 chars/)).toBeInTheDocument();
    // The left half is the editor's now — the verify definition it replaced is gone, not covered.
    expect(screen.queryByText('Verify command')).not.toBeInTheDocument();
  });

  it('colours the text, picking the language from the field it came from', async () => {
    // A verify command is shell and a seeded .js file is not, and neither is worth reading as an
    // undifferentiated wall — the language comes from the field rather than being asked for.
    mockApi([experiment({
      tasks: [{ id: 't1', name: 'fib', prompt: 'p', verifyCommand: 'node t.js --strict "out"' }],
      variants: [{ label: 'a', overrides: {} }],
    })]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/Open full screen/));
    await screen.findByDisplayValue(/node t\.js/);
    fireEvent.click(screen.getByTitle(/Edit Verify command in the full editor/));

    // Tokens, not plain text: the flag and the quoted string are their own elements.
    expect(await screen.findByText('--strict')).toBeInTheDocument();
    expect(screen.getByText('"out"')).toBeInTheDocument();
  });

  it('opens an unset text knob on the value in force, not on nothing', async () => {
    // The whole reason to expand systemPrompt is to tune the prompt the agent is running, and it
    // is unset on the variant precisely because nobody has changed it yet. A blank editor asks you
    // to retype 1,600 characters you cannot see.
    mockApi([experiment({
      tasks: [{ id: 't1', name: 'fib', prompt: 'p', verifyCommand: 'v' }],
      variants: [{ label: 'a', overrides: {} }],
    })]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/Open full screen/));
    await screen.findByDisplayValue('v');
    fireEvent.click(screen.getByRole('button', { name: 'options' }));
    fireEvent.click(await screen.findByTitle(/Edit System prompt \(full replace\) in the full editor/));

    // The generated prompt, found via the knob's promptId rather than by knowing its key.
    expect(await screen.findByLabelText('System prompt (full replace)'))
      .toHaveValue('GENERATED AGENT PROMPT with sandbox facts');
    // The field behind is still empty, so the knob is still inherited until this is saved.
    expect(screen.getByText(/loaded from the harness default/)).toBeInTheDocument();
  });

  it('offers the editor for text and not for numbers, which have nothing to expand into', async () => {
    // A temperature is one value. Offering to open it full screen suggests there is more of it to
    // see, and there is nothing to prepopulate that the placeholder does not already say.
    mockApi([experiment({
      tasks: [{ id: 't1', name: 'fib', prompt: 'p', verifyCommand: 'v' }],
      variants: [{ label: 'a', overrides: {} }],
    })]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/Open full screen/));
    await screen.findByDisplayValue('v');
    fireEvent.click(screen.getByRole('button', { name: 'options' }));

    const numeric = (await screen.findByText('temperature')).closest('tr')!;
    expect(within(numeric).queryByTitle(/in the full editor/)).not.toBeInTheDocument();
    // Decided by the registry's declared type, so a string knob in the same table still has it.
    const text = screen.getByText('extraInstructions').closest('tr')!;
    expect(within(text).getByTitle(/in the full editor/)).toBeInTheDocument();
  });

  it('holds the edit until Save, so the field behind it is untouched meanwhile', async () => {
    // The editor is a transaction. Reworking a long prompt and then wanting the original back is
    // not undoable by hand, and nothing else on the page remembers it.
    await openEditor(/Edit Prompt — fib in the full editor/);

    // Two fields hold the value: the inline one and the editor's. Addressed by name rather than
    // by position, which flipped when the editor moved into the left pane.
    expect(screen.getAllByDisplayValue('a short prompt')).toHaveLength(2);
    fireEvent.change(await screen.findByLabelText('Prompt — fib'), {
      target: { value: 'a much longer reworded prompt' },
    });

    // Still only in the draft — the field behind has not moved.
    expect(screen.getByDisplayValue('a short prompt')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByText(/modified/)).not.toBeInTheDocument());
    expect(screen.getByDisplayValue('a much longer reworded prompt')).toBeInTheDocument();
  });

  it('discards the draft on Escape without leaving the focus view', async () => {
    // One keypress should abandon the edit, not also leave the screen — the outer view listens
    // for Escape too.
    await openEditor(/Edit Prompt — fib in the full editor/);

    fireEvent.change(await screen.findByLabelText('Prompt — fib'), { target: { value: 'discard me' } });
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByDisplayValue('discard me')).not.toBeInTheDocument());
    expect(screen.getByDisplayValue('a short prompt')).toBeInTheDocument();
    expect(screen.getByText('Verify command')).toBeInTheDocument();
  });

  it('commits through the current handler, not the one captured when it opened', async () => {
    // The open request carries an onChange closing over the task as it was. Koala sits in the
    // right pane and can revise that same task while the editor is up on the left, so committing
    // through the stale closure would silently undo the revision that was just accepted.
    await openEditor(/Edit Verify command in the full editor/);

    fireEvent.click(screen.getByText('Koala'));
    const ask = await screen.findByPlaceholderText(/ask about this task/);
    mockedAxios.post.mockResolvedValueOnce({
      data: { reply: 'It needs seeding.', revision: { seed: [{ path: 'data.txt', content: 'hello' }] } },
    });
    fireEvent.change(ask, { target: { value: 'why does this fail?' } });
    fireEvent.keyDown(ask, { key: 'Enter' });
    fireEvent.click(await screen.findByText('apply'));

    fireEvent.change(screen.getByLabelText('Verify command'), { target: { value: 'node check.js' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Both survive: the seed accepted during the edit, and the edit itself.
    expect(await screen.findByDisplayValue('node check.js')).toBeInTheDocument();
    expect(screen.getByDisplayValue('data.txt')).toBeInTheDocument();
  });
});

/** A GET for one experiment's detail, which is the query the full-screen view actually reads. */
const detailCall = (call: unknown[]) =>
  typeof call[0] === 'string' && /\/harness\/experiments\/[^/]+$/.test(call[0]);

describe('running and promoting from full screen', () => {
  const focusable = () => experiment({
    tasks: [{ id: 't1', name: 'fib', prompt: 'p', verifyCommand: 'node t.js' }],
    variants: [{ label: 'a', overrides: {} }],
    results: [{ taskId: 't1', label: 'a', verified: true, succeeded: true, steps: 2, tokensUsed: 10 }],
  });

  const openFocus = async (record: any) => {
    mockApi([record]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/Open full screen/));
    await screen.findByDisplayValue('node t.js');
  };

  it('starts the suite without leaving the view', async () => {
    // Tuning happens here, so having to close the screen to measure the change is the loop this
    // view exists to shorten.
    await openFocus(focusable());
    mockedAxios.post.mockResolvedValueOnce({ data: {} });

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledWith(
      '/api/harness/experiments/exp-1/run', {}, expect.anything(),
    ));
  });

  it('saves before running when there are edits, and says so on the button', async () => {
    // A run measures what the server holds. Running with edits on screen would file a record of
    // the old wording under the new one's name.
    await openFocus(focusable());
    fireEvent.change(screen.getByDisplayValue('node t.js'), { target: { value: 'node other.js' } });

    expect(screen.getByRole('button', { name: 'Save & run' })).toBeInTheDocument();
    mockedAxios.put.mockResolvedValueOnce({ data: {} });
    mockedAxios.post.mockResolvedValueOnce({ data: {} });
    fireEvent.click(screen.getByRole('button', { name: 'Save & run' }));

    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledWith(
      '/api/harness/experiments/exp-1/run', {}, expect.anything(),
    ));
    // The edit reached the server first — the order is the point, not just that both happened.
    expect(mockedAxios.put).toHaveBeenCalledWith(
      '/api/harness/experiments/exp-1',
      expect.objectContaining({ tasks: [expect.objectContaining({ verifyCommand: 'node other.js' })] }),
      expect.anything(),
    );
    expect(mockedAxios.put.mock.invocationCallOrder[0]!)
      .toBeLessThan(mockedAxios.post.mock.invocationCallOrder.at(-1)!);
  });

  it('refetches this experiment after saving, so the edit is not visibly thrown away', async () => {
    // The page invalidates the experiment LIST; this view reads a different query. Without
    // refetching it, a save cleared the local draft and re-rendered from the stale cached detail —
    // so a save that worked perfectly looked exactly like a discarded edit.
    await openFocus(focusable());
    const before = mockedAxios.get.mock.calls.filter((c) => detailCall(c)).length;

    fireEvent.change(screen.getByDisplayValue('node t.js'), { target: { value: 'node other.js' } });
    mockedAxios.put.mockResolvedValueOnce({ data: {} });
    fireEvent.click(screen.getByText('Save experiment'));

    await waitFor(() => expect(
      mockedAxios.get.mock.calls.filter((c) => detailCall(c)).length,
    ).toBeGreaterThan(before));
  });

  it('refetches after starting, or nothing ever turns the poll on', async () => {
    // The poll interval is evaluated against the data in hand. Left saying nothing is running, it
    // returns false forever and the run is invisible until something else forces a fetch.
    await openFocus(focusable());
    const before = mockedAxios.get.mock.calls.filter((c) => detailCall(c)).length;

    mockedAxios.post.mockResolvedValueOnce({ data: {} });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(
      mockedAxios.get.mock.calls.filter((c) => detailCall(c)).length,
    ).toBeGreaterThan(before));
  });

  it('will not start a suite that is already running', async () => {
    await openFocus(experiment({
      tasks: [{ id: 't1', name: 'fib', prompt: 'p', verifyCommand: 'node t.js' }],
      variants: [{ label: 'a', overrides: {} }],
      status: 'running',
    }));

    expect(screen.getByRole('button', { name: 'Running' })).toBeDisabled();
  });

  it('promotes the selected variant, showing the standing and the diff first', async () => {
    // "Promote" sounds like it changes one thing and usually does not, so what would change is
    // fetched and shown before anything is applied.
    await openFocus(focusable());

    fireEvent.click(screen.getByRole('button', { name: /Promote/ }));

    // The standing, then the button that applies it.
    expect(await screen.findByText(/verified 4\/4 across 2 tasks/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adopt' })).toBeInTheDocument();
  });

  it('refuses to promote a variant nothing has run', async () => {
    // Promotion is a claim about evidence. With no runs behind it there is nothing to claim.
    await openFocus(experiment({
      tasks: [{ id: 't1', name: 'fib', prompt: 'p', verifyCommand: 'node t.js' }],
      variants: [{ label: 'a', overrides: {} }],
      results: [],
    }));

    expect(screen.getByRole('button', { name: /Promote/ })).toBeDisabled();
  });
});

describe('reading what came back', () => {
  const result = (over: any = {}) => ({
    taskId: 't1', label: 'a', verified: true, succeeded: true, steps: 2, tokensUsed: 10,
    verifyExitCode: 0, verifyOutput: '', durationMs: 100, summary: '', transcript: [],
    ...over,
  });

  const openFocus = async (record: any) => {
    mockApi([record]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/Open full screen/));
    await screen.findByDisplayValue('node t.js');
  };

  const suite = (results: any[]) => experiment({
    tasks: [{ id: 't1', name: 'fib', prompt: 'p', verifyCommand: 'node t.js' }],
    variants: [{ label: 'a', overrides: {} }],
    results,
  });

  it('streams the run in flight instead of showing the previous attempt', async () => {
    // The pane used to render the last stored result no matter what, so during a run you sat
    // reading the output of the attempt before it with nothing saying so.
    await openFocus(suite([result({ conversation: [{ role: 'assistant', content: 'OLD ANSWER' }] })]));

    push('experiment-run-started', {
      experimentId: 'exp-1', taskId: 't1', taskName: 'fib', label: 'a', done: 1, total: 3,
    });
    push('experiment-step', {
      experimentId: 'exp-1', taskId: 't1', label: 'a',
      step: { step: 1, content: 'FRESH TURN', toolCalls: [], toolResults: [], tokens: 40 },
    });

    expect(await screen.findByText('FRESH TURN')).toBeInTheDocument();
    expect(screen.queryByText('OLD ANSWER')).not.toBeInTheDocument();
    // Which combination the suite has reached — usually not the one selected on screen.
    expect(screen.getByText(/run 1\/3/)).toBeInTheDocument();
  });

  it('lets you read every repeat, not silently the last one', async () => {
    // Repeats exist to show variance. Collapsing them to one defeats the reason for asking.
    await openFocus(suite([
      result({ verified: false, trace: [{ step: 1, content: 'FIRST TRY', toolCalls: [], toolResults: [], tokens: 5 }] }),
      result({ verified: true, trace: [{ step: 1, content: 'SECOND TRY', toolCalls: [], toolResults: [], tokens: 5 }] }),
    ]));

    // Latest by default, which is what you want once a run lands.
    expect(await screen.findByText('SECOND TRY')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue(/repeat 2\/2/), { target: { value: '0' } });
    expect(await screen.findByText('FIRST TRY')).toBeInTheDocument();
  });

  it('names the two recordings rather than silently substituting one for the other', async () => {
    // `conversation` is what the model was SENT; `trace` is what it PRODUCED. The old pane showed
    // the first and fell back to the second, so the same pane meant different things per run.
    await openFocus(suite([result({
      conversation: [{ role: 'system', content: 'WHAT IT WAS SENT' }],
      trace: [{ step: 1, content: 'WHAT IT PRODUCED', toolCalls: [], toolResults: [], tokens: 5 }],
    })]));

    expect(await screen.findByText('WHAT IT PRODUCED')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sent' }));
    expect(await screen.findByText('WHAT IT WAS SENT')).toBeInTheDocument();
  });

  it('shows the verify output, which is the number that actually decides the score', async () => {
    await openFocus(suite([result({
      verified: false, verifyExitCode: 1, verifyOutput: 'AssertionError: expected 8',
      trace: [{ step: 1, content: 'x', toolCalls: [], toolResults: [], tokens: 5 }],
    })]));

    expect(await screen.findByText(/AssertionError: expected 8/)).toBeInTheDocument();
    expect(screen.getByText(/verify · exit 1/)).toBeInTheDocument();
  });
});

describe('picking a model', () => {
  const withModel = () => experiment({
    tasks: [{ id: 't1', name: 'fib', prompt: 'p', verifyCommand: 'v' }],
    variants: [{ label: 'a', overrides: {} }],
  });

  it('offers the model APIs that exist rather than taking a typed id', async () => {
    // The value is a provider id — opaque, and unresolvable if it does not match one, so free text
    // could only ever produce "Model X not found".
    mockApi([withModel()]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/Open full screen/));
    await screen.findByDisplayValue('v');
    fireEvent.click(screen.getByRole('button', { name: 'options' }));

    const row = (await screen.findByText('model')).closest('tr')!;
    const picker = within(row).getByRole('combobox');
    // Named as deployed, with what it serves — two deployments of one engine are otherwise
    // distinguishable only by a name someone typed.
    expect(within(picker).getByRole('option', { name: /Tabbyapi Production — Qwen3-32B · tabbyapi/ }))
      .toBeInTheDocument();
    // Unset stays reachable: it means "whatever the harness picks", not a model.
    expect(within(picker).getByRole('option', { name: /unset/ })).toBeInTheDocument();
    expect(within(row).queryByRole('textbox')).not.toBeInTheDocument();

    fireEvent.change(picker, { target: { value: 'end-1' } });
    expect((picker as HTMLSelectElement).value).toBe('end-1');
  });

  it('says so when there is nothing to pick, rather than showing an empty menu', async () => {
    // Listing models touches the cluster and is allowed to fail without taking the page with it,
    // so "none" is a state this has to render honestly.
    mockApi([withModel()], {
      config: {
        ...config,
        tunables: config.tunables.map((t: any) => (t.key === 'model' ? { ...t, choices: [] } : t)),
      },
    });
    renderLab();
    fireEvent.click(await screen.findByTitle(/Open full screen/));
    await screen.findByDisplayValue('v');
    fireEvent.click(screen.getByRole('button', { name: 'options' }));

    const row = (await screen.findByText('model')).closest('tr')!;
    expect(within(row).getByText('no models available')).toBeInTheDocument();
  });
});

describe('hover descriptions on options', () => {
  it('explains what a knob does, what it is set to, and where to change it', async () => {
    // A tooltip whose first line is a file path has buried the answer, so the order is: what it
    // does, what it is set to and why, the bounds, then the source.
    mockApi([experiment({
      tasks: [{ id: 't1', name: 'fib', prompt: 'p', verifyCommand: 'v' }],
      variants: [{ label: 'a', overrides: {} }],
    })]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/Open full screen/));
    await screen.findByDisplayValue('v');
    fireEvent.click(screen.getByRole('button', { name: 'options' }));

    const row = (await screen.findByText('temperature')).closest('tr')!;
    const tip = row.getAttribute('title')!;
    expect(tip).toMatch(/^Temperature/);
    expect(tip).toMatch(/Choosing a tool is not a creative act/);
    expect(tip).toMatch(/Range 0 to 2, step 0\.05/);
    expect(tip).toMatch(/Set in lib\/sampling\.ts/);
  });

  it('says when the value in force is an adopted one rather than the built-in', async () => {
    // The distinction the whole effective-config change exists for.
    mockApi([experiment({
      tasks: [{ id: 't1', name: 'fib', prompt: 'p', verifyCommand: 'v' }],
      variants: [{ label: 'a', overrides: {} }],
    })]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/Open full screen/));
    await screen.findByDisplayValue('v');
    fireEvent.click(screen.getByRole('button', { name: 'options' }));

    const tip = (await screen.findByText('temperature')).closest('tr')!.getAttribute('title')!;
    expect(tip).toMatch(/Currently 0\.9 \(adopted default, not the built-in\)/);
  });

  it('warns on the knob itself that an engine-gated one is dropped elsewhere', async () => {
    // It is accepted, stored, and then silently not sent — worth saying where it is chosen.
    renderLab();
    fireEvent.click(await screen.findByText('New experiment'));
    const dry = await screen.findByRole('button', { name: /DRY multiplier/ });
    expect(dry.getAttribute('title')).toMatch(/Only sent to tabbyapi; dropped on any other engine/);
  });

  it('says when a knob never reaches the model at all', async () => {
    renderLab();
    fireEvent.click(await screen.findByText('New experiment'));
    const steps = await screen.findByRole('button', { name: /Max steps/ });
    expect(steps.getAttribute('title')).toMatch(/Read by the agent loop — never sent to the model/);
  });
});

describe('run history', () => {
  const hist = (over: Record<string, unknown> = {}) => experiment({
    history: [
      { id: 'r1', startedAt: '2026-08-04T09:00:00Z', status: 'complete', model: 'qwen3', verified: 1, runs: 3 },
      { id: 'r2', startedAt: '2026-08-04T14:00:00Z', status: 'complete', model: 'qwen3', verified: 3, runs: 3 },
    ],
    ...over,
  });

  it('keeps every execution rather than overwriting the last', async () => {
    // Running an experiment used to clear its results, so a suite was a question you could ask
    // exactly once — the opposite of a benchmark you re-run after a change.
    mockApi([hist()]);
    renderLab();
    await cardTab(/^History/);
    expect(await screen.findByText('1/3')).toBeInTheDocument();
    expect(screen.getByText('3/3')).toBeInTheDocument();
  });

  it('says how much the latest run moved against the one before it', async () => {
    mockApi([hist()]);
    renderLab();
    await cardTab(/^History/);
    expect(await screen.findByText(/\+67 points vs the previous run/)).toBeInTheDocument();
  });

  it('shows no history panel for an experiment run only once', async () => {
    mockApi([experiment({ history: [
      { id: 'r1', startedAt: '2026-08-04T09:00:00Z', status: 'complete', verified: 1, runs: 3 },
    ] })]);
    renderLab();
    await screen.findByText('reasoning on/off');
    expect(screen.queryByRole('button', { name: /^History/ })).not.toBeInTheDocument();
  });
});

describe('the prompts of a past experiment', () => {
  it('shows the prompt and verify command that actually ran', async () => {
    // Without this an experiment is a name and a score, and a week later there is no way to read
    // what was asked.
    mockApi([experiment({ results: [result()] })]);
    renderLab();
    await cardTab(/^Tasks/);
    expect(await screen.findByText('do t1')).toBeInTheDocument();
    expect(screen.getByText(/node test\.js/)).toBeInTheDocument();
  });

  it('says which past results measured the old wording, without deleting them', async () => {
    // Deleting them would throw away the evidence that makes "re-run after the change" answerable,
    // which is the entire reason the suite is written down.
    mockApi([experiment({ results: [result()] })]);
    renderLab();
    await cardTab(/^Tasks/);
    await screen.findByText('do t1');
    fireEvent.click(await screen.findByText('Edit prompts'));
    fireEvent.change(screen.getByDisplayValue('do t1'), { target: { value: 'do t1 differently' } });
    // Kept, not discarded: every execution records the prompt it was actually sent, so an old run
    // describes what was asked then rather than making a claim about what is asked now.
    expect(await screen.findByText(/1 past result measured the old wording/)).toBeInTheDocument();
    expect(screen.getByText(/kept in history/)).toBeInTheDocument();
  });

  it('does not warn when the edit leaves the wording alone', async () => {
    mockApi([experiment({ results: [result()] })]);
    renderLab();
    await cardTab(/^Tasks/);
    await screen.findByText('do t1');
    fireEvent.click(await screen.findByText('Edit prompts'));
    fireEvent.change(screen.getByDisplayValue('fib'), { target: { value: 'fibonacci' } });
    expect(screen.queryByText(/measured the old wording/)).not.toBeInTheDocument();
  });

  it('saves the edited suite back to the experiment', async () => {
    mockApi([experiment()]);
    renderLab();
    await cardTab(/^Tasks/);
    await screen.findByText('do t1');
    fireEvent.click(await screen.findByText('Edit prompts'));
    fireEvent.change(screen.getByDisplayValue('do t1'), { target: { value: 'reworded' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(mockedAxios.put).toHaveBeenCalledWith(
      '/api/harness/experiments/exp-1',
      { tasks: [expect.objectContaining({ prompt: 'reworded' })] },
      expect.anything(),
    ));
  });

  it('refuses to edit while the experiment is running', async () => {
    mockApi([experiment({ running: true, status: 'running' })]);
    renderLab();
    await cardTab(/^Tasks/);
    expect(await screen.findByText('Edit prompts')).toBeDisabled();
  });

  it('duplicates without the results, to try a rewording non-destructively', async () => {
    mockApi([experiment({ results: [result()] })]);
    renderLab();
    fireEvent.click(await screen.findByTitle(/Duplicate/));
    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledWith(
      '/api/harness/experiments/exp-1/duplicate', {}, expect.anything(),
    ));
  });
});

describe('running an experiment', () => {
  it('posts to the run endpoint', async () => {
    mockApi([experiment()]);
    renderLab();
    await waitFor(() => expect(screen.getByTitle(/Run/)).toBeInTheDocument());
    fireEvent.click(screen.getByTitle(/Run/));
    await waitFor(() =>
      expect(mockedAxios.post).toHaveBeenCalledWith('/api/harness/experiments/exp-1/run', {}, expect.anything()));
  });

  it('shows progress instead of a run button while it is running', async () => {
    // Each run is a real sandbox, so a second click must not be possible.
    mockApi([experiment({ running: true, status: 'running', progress: '2/4 — think=true' })]);
    renderLab();
    await waitFor(() => expect(screen.getByText(/2\/4 — think=true/)).toBeInTheDocument());
    expect(screen.queryByTitle(/Run/)).not.toBeInTheDocument();
  });
});

describe('creating an experiment', () => {
  it('says how many real sandboxes it will create before you run it', async () => {
    renderLab();
    await waitFor(() => expect(screen.getByText('New experiment')).toBeInTheDocument());
    fireEvent.click(screen.getByText('New experiment'));
    // think=[false,true] is on by default, so two.
    await waitFor(() => expect(screen.getByText(/2 sandboxes will be created/)).toBeInTheDocument());
  });

  it('explains that the verify command, not the agent, decides success', async () => {
    renderLab();
    fireEvent.click(await screen.findByText('New experiment'));
    expect(await screen.findByText(/not the agent's own report/)).toBeInTheDocument();
  });

  it('refuses a design with more variants than the server will run', async () => {
    // Three axes cross to 8, over the limit of 6. The server rejects rather than silently dropping
    // two combinations, so the form must not promise a run it cannot make.
    renderLab();
    fireEvent.click(await screen.findByText('New experiment'));
    // By role: "Max steps" is also a label in the configuration panel above.
    fireEvent.click(await screen.findByRole('button', { name: /Max steps/ }));
    fireEvent.click(screen.getByRole('button', { name: /Temperature/ }));
    await waitFor(() => expect(screen.getByText(/8 variants is over the limit of 6/)).toBeInTheDocument());
    expect(screen.getByText('Create')).toBeDisabled();
  });

  it('builds the axis picker from the server registry, not a list of its own', async () => {
    // A hardcoded list is how this surface came to offer a temperature axis that changed nothing:
    // the picker knew about a knob the request never carried.
    renderLab();
    fireEvent.click(await screen.findByText('New experiment'));
    expect(await screen.findByRole('button', { name: /DRY multiplier/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Max steps/ })).toBeInTheDocument();
    // No suggested pair, so it is sendable but not offered as a one-click axis.
    expect(screen.queryByRole('button', { name: /Seed/ })).not.toBeInTheDocument();
  });

  it('marks an engine-gated knob, since it is dropped rather than run elsewhere', async () => {
    renderLab();
    fireEvent.click(await screen.findByText('New experiment'));
    const dry = await screen.findByRole('button', { name: /DRY multiplier/ });
    expect(within(dry).getByText('tabbyapi')).toBeInTheDocument();
  });

  it('varies the knob the registry named, using its suggested ends', async () => {
    renderLab();
    fireEvent.click(await screen.findByText('New experiment'));
    fireEvent.change(await screen.findByPlaceholderText(/^Name/), { target: { value: 'exp' } });
    fireEvent.change(screen.getByPlaceholderText(/Given to the agent verbatim/), { target: { value: 'do it' } });
    fireEvent.change(screen.getByPlaceholderText(/Verify command/), { target: { value: 'node t.js' } });
    fireEvent.click(screen.getByRole('button', { name: /Reasoning on dispatch turns/ })); // off — on by default
    fireEvent.click(screen.getByRole('button', { name: /Temperature/ }));
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledWith(
      '/api/harness/experiments',
      expect.objectContaining({ axes: { temperature: [0.2, 0.7] } }),
      expect.anything(),
    ));
  });

  it('sends axes so variants differ in one thing at a time', async () => {
    renderLab();
    fireEvent.click(await screen.findByText('New experiment'));
    fireEvent.change(await screen.findByPlaceholderText(/^Name/), { target: { value: 'exp' } });
    fireEvent.change(screen.getByPlaceholderText(/Given to the agent verbatim/), { target: { value: 'do it' } });
    fireEvent.change(screen.getByPlaceholderText(/Verify command/), { target: { value: 'node t.js' } });
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledWith(
      '/api/harness/experiments',
      expect.objectContaining({ axes: { think: [false, true] }, name: 'exp' }),
      expect.anything(),
    ));
  });

  it('sends a suite, each task with its own verify command', async () => {
    // Tasks in a useful suite check different things, so one shared command would either fit a
    // single task or be generic enough to verify nothing.
    renderLab();
    fireEvent.click(await screen.findByText('New experiment'));
    fireEvent.change(await screen.findByPlaceholderText(/^Name/), { target: { value: 'exp' } });
    fireEvent.change(screen.getByPlaceholderText(/Task 1 name/), { target: { value: 'fib' } });
    fireEvent.change(screen.getByPlaceholderText(/Given to the agent verbatim/), { target: { value: 'do fib' } });
    fireEvent.change(screen.getByPlaceholderText(/Verify command/), { target: { value: 'node fib.js' } });

    fireEvent.click(screen.getByText('Add task'));
    fireEvent.change(await screen.findByPlaceholderText(/Task 2 name/), { target: { value: 'csv' } });
    fireEvent.change(screen.getAllByPlaceholderText(/Given to the agent verbatim/)[1]!, { target: { value: 'do csv' } });
    fireEvent.change(screen.getAllByPlaceholderText(/Verify command/)[1]!, { target: { value: 'node csv.js' } });

    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledWith(
      '/api/harness/experiments',
      expect.objectContaining({
        tasks: [
          { name: 'fib', prompt: 'do fib', verifyCommand: 'node fib.js', language: 'node' },
          { name: 'csv', prompt: 'do csv', verifyCommand: 'node csv.js', language: 'node' },
        ],
      }),
      expect.anything(),
    ));
  });

  it('counts the suite into the sandbox total', async () => {
    renderLab();
    fireEvent.click(await screen.findByText('New experiment'));
    await waitFor(() => expect(screen.getByText(/2 sandboxes will be created/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('Add task'));
    // Two tasks × two variants, and every task is run by every variant.
    await waitFor(() => expect(screen.getByText(/4 sandboxes will be created/)).toBeInTheDocument());
  });

  it('refuses a suite whose product runs past the ceiling', async () => {
    // Reached by three individually reasonable choices, none over its own limit.
    renderLab();
    fireEvent.click(await screen.findByText('New experiment'));
    for (let i = 0; i < 9; i++) fireEvent.click(screen.getByText('Add task'));
    // By display value, because every task card carries a language select of its own.
    fireEvent.change(screen.getByDisplayValue('1 run per task'), { target: { value: '5' } });
    await waitFor(() => expect(screen.getByText(/10 × 2 × 5 is 100 sandboxes/)).toBeInTheDocument());
    expect(screen.getByText('Create')).toBeDisabled();
  });
});
