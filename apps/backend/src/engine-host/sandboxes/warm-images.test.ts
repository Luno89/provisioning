import { describe, it, expect, vi } from 'vitest';
import { ALL_SEEDED_AGENTS, type Persona, type ToolDefinition } from '@koala/agent-engine';
import { ENGINE_TOOL_SEEDS } from '../tools/engine-tool-seeds.js';
import { createWorkspaceImages, sayWaiting } from './warm-images.js';
import type { ImageStanding } from './image-builder.js';

const tools = (): ToolDefinition[] => [...ENGINE_TOOL_SEEDS];

const personas = (): Persona[] => ALL_SEEDED_AGENTS();

function builder(over: { standing?: ImageStanding } = {}) {
  const started: string[] = [];
  const standing = over.standing ?? { state: 'unbuilt' as const, reference: 'registry/koala:abc' };

  return {
    started,
    images: {
      standing: vi.fn(async () => standing),
      start: vi.fn(async (plan: { fingerprint: string }) => {
        if (standing.state !== 'unbuilt') return standing;
        started.push(plan.fingerprint);
        return { state: 'building' as const, reference: standing.reference };
      }),
    },
  };
}

describe('getting workspace images built before a run needs them', () => {
  it('starts one build per distinct image, not one per persona', async () => {
    const { images, started } = builder();
    const workspace = createWorkspaceImages({ images, personas: async () => personas(), tools: async () => tools() });

    const warmed = await workspace.warm();

    expect(warmed.length).toBeGreaterThan(0);
    expect(new Set(started).size).toBe(started.length);
    expect(warmed.every((image) => image.state === 'building')).toBe(true);
  });

  it('leaves personas that need no machine out of it entirely', async () => {
    const { images } = builder();
    const workspace = createWorkspaceImages({
      images,
      personas: async () => personas().filter((persona) => ['koala', 'planner'].includes(persona.slug)),
      tools: async () => tools(),
    });

    expect(await workspace.warm()).toEqual([]);
    expect(images.start).not.toHaveBeenCalled();
  });

  it('starts nothing when the image is already there', async () => {
    const { images } = builder({ standing: { state: 'ready', reference: 'registry/koala:abc' } });
    const workspace = createWorkspaceImages({ images, personas: async () => personas(), tools: async () => tools() });

    const warmed = await workspace.warm();

    expect(warmed.every((image) => image.state === 'ready')).toBe(true);
  });

  it('reports a build it could not start rather than throwing the boot', async () => {
    const problems: string[] = [];
    const images = {
      standing: vi.fn(async () => ({ state: 'unbuilt' as const, reference: '' })),
      start: vi.fn(async () => { throw new Error('the registry is not up'); }),
    };
    const workspace = createWorkspaceImages({
      images,
      personas: async () => personas(),
      tools: async () => tools(),
      onProblem: (agent, problem) => problems.push(`${agent}: ${problem}`),
    });

    const warmed = await workspace.warm();

    expect(warmed.every((image) => image.state === 'failed')).toBe(true);
    expect(problems[0]).toContain('the registry is not up');
  });
});

describe('what a run is told while it waits', () => {
  it('says an image is building, and for whom', () => {
    expect(sayWaiting({ agent: 'executor', fingerprint: 'abc', state: 'building', reference: 'r' }))
      .toContain('Building the workspace image for executor');
  });

  it('says why a build failed', () => {
    expect(sayWaiting({ agent: 'executor', fingerprint: 'abc', state: 'failed', reference: 'r', detail: 'no registry' }))
      .toContain('no registry');
  });

  it('says nothing when the image is ready, so a normal run is quiet', () => {
    expect(sayWaiting({ agent: 'executor', fingerprint: 'abc', state: 'ready', reference: 'r' })).toBeUndefined();
    expect(sayWaiting(undefined)).toBeUndefined();
  });

  it('tells a run about its own persona\'s image', async () => {
    const { images } = builder({ standing: { state: 'building', reference: 'registry/koala:abc' } });
    const workspace = createWorkspaceImages({ images, personas: async () => personas(), tools: async () => tools() });

    expect(await workspace.waiting('user-1', 'executor')).toContain('Building the workspace image for executor');
    expect(await workspace.waiting('user-1', 'koala')).toBeUndefined();
    expect(await workspace.waiting('user-1', 'nobody')).toBeUndefined();
  });
});
