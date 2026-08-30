import { describe, it, expect } from 'vitest';
import { buildHarnessConfig } from './harness-config.js';
import { TOOL_TURN_MAX_TOKENS, toolTurnSampling, TOOL_DISCIPLINE_PROMPT } from './sampling.js';
import { MAX_AGENT_STEPS } from './sandbox-tools.js';
import { PLAN_MODE_MAX_TOKENS, PLAN_SYSTEM_PROMPT } from './plan-mode.js';
import { WORKSPACE_IMAGES } from './workspace-spec.js';
import { ALL_TOOL_SEEDS } from './tool-seeds.js';
import { forSurface } from './tool-catalogue.js';

const SANDBOX_TOOLS = forSurface(ALL_TOOL_SEEDS, 'sandbox');

const config = buildHarnessConfig({}, [], ALL_TOOL_SEEDS);
const find = (sectionId: string, label: string) =>
  config.sections.find((s) => s.id === sectionId)!.settings.find((x) => x.label === label)!;

describe('the harness config surface', () => {
  it('reads the dispatch token cap from the sampling module', () => {
    expect(find('agent', 'Tokens per dispatch turn').value).toBe(String(TOOL_TURN_MAX_TOKENS));
  });

  it('reads the step ceiling from the agent module', () => {
    expect(find('agent', 'Max steps').value).toBe(String(MAX_AGENT_STEPS));
  });

  it('lists the tools the agent is actually given', () => {
    for (const tool of SANDBOX_TOOLS) {
      expect(find('agent', 'Tools').value).toContain(tool.function.name);
    }
  });

  it('reads the sampler values rather than repeating them', () => {
    const live = toolTurnSampling('tabbyapi');
    expect(find('sampling', 'Dispatch temperature').value).toBe(String(live.temperature));
    expect(find('sampling', 'DRY (TabbyAPI only)').value).toContain(String(live.dry_multiplier));
  });

  it('reads the plan budget from plan-mode', () => {
    expect(find('chat', '/plan token budget').value).toBe(String(PLAN_MODE_MAX_TOKENS));
  });

  it('shows prompts verbatim, so what the model is told is inspectable', () => {
    expect(config.prompts.find((p) => p.id === 'plan')!.text).toBe(PLAN_SYSTEM_PROMPT);
    expect(config.prompts.find((p) => p.id === 'discipline')!.text).toBe(TOOL_DISCIPLINE_PROMPT);
  });

  it('offers exactly the languages the catalogue has', () => {
    expect(config.languages.map((l) => l.id).sort()).toEqual(Object.keys(WORKSPACE_IMAGES).sort());
    for (const l of config.languages) expect(l.image).toBe(WORKSPACE_IMAGES[l.id].image);
  });

  it('explains the values that exist because something broke', () => {
    expect(find('agent', 'Reasoning on dispatch turns').note).toBeTruthy();
    expect(find('chat', '/plan token budget').note).toMatch(/7,908|silently/);
  });
});

describe('discovered choices', () => {
  const models = [
    { id: 'dep-1', name: 'Tabbyapi Production', model: 'Qwen3-32B', source: 'deployment', kind: 'tabbyapi' as const },
    { id: 'end-1', name: 'Workstation', model: 'llama-3.1-8b', source: 'endpoint' },
  ];

  it('fills a knob’s choices from what the caller can actually reach', () => {
    const knob = buildHarnessConfig({}, models).tunables.find((t) => t.key === 'model')!;
    expect(knob.choices).toEqual([
      { value: 'dep-1', label: 'Tabbyapi Production', note: 'Qwen3-32B · tabbyapi' },
      { value: 'end-1', label: 'Workstation', note: 'llama-3.1-8b · endpoint' },
    ]);
  });

  it('keeps the knob with an empty list when there is nothing to offer', () => {
    const knob = buildHarnessConfig({}, []).tunables.find((t) => t.key === 'model')!;
    expect(knob.choices).toEqual([]);
  });

  it('leaves knobs that declare no source alone', () => {
    const knob = buildHarnessConfig({}, models).tunables.find((t) => t.key === 'temperature')!;
    expect(knob.choices).toBeUndefined();
  });
});
