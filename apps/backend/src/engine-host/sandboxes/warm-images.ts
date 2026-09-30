import { needsBuilding, planFor, type Persona, type ToolDefinition } from '@koala/agent-engine';
import type { ImageBuilder, ImageStanding } from './image-builder.js';
import { mergeWorkspaceAgents } from './environments.js';
import { GROVE_WORKSPACE_AGENTS } from './tree-workspaces.js';

export interface WorkspaceImage extends ImageStanding {
  agent: string;
  fingerprint: string;
}

/** A fingerprint something would still run on, and what needs it. */
export interface WantedImage {
  fingerprint: string;
  who: string;
}

export interface WarmImagesOptions {
  images: Pick<ImageBuilder, 'start' | 'standing'>;
  personas(ownerId?: string): Promise<Persona[]>;
  tools(ownerId?: string): Promise<ToolDefinition[]>;
  /** Everyone whose agents could run. Without it, only the owners who have rows of their own. */
  owners?(): Promise<string[]>;
  onProblem?: ((agent: string, problem: string) => void) | undefined;
}

export interface WorkspaceImages {
  standing(ownerId?: string): Promise<WorkspaceImage[]>;
  warm(ownerId?: string): Promise<WorkspaceImage[]>;
  waiting(ownerId: string, agentSlug: string): Promise<string | undefined>;
  wanted(): Promise<WantedImage[]>;
}

export function sayWaiting(image: WorkspaceImage | undefined): string | undefined {
  if (image?.state === 'building') return `Building the workspace image for ${image.agent}. The first run after a change to what it needs waits for this.`;
  if (image?.state === 'failed') return `The workspace image for ${image.agent} did not build: ${image.detail ?? 'no reason given'}`;
  return undefined;
}

export function createWorkspaceImages(options: WarmImagesOptions): WorkspaceImages {
  const planned = async (ownerId?: string) => {
    const [personas, tools] = await Promise.all([options.personas(ownerId), options.tools(ownerId)]);

    return personas.flatMap((persona) => {
      const plan = planFor(persona, tools);
      return plan ? [{ agent: persona.slug, plan }] : [];
    });
  };

  const each = async (ownerId: string | undefined, take: (plan: Parameters<ImageBuilder['start']>[0]) => Promise<ImageStanding>) => {
    const wanted = await planned(ownerId);
    const seen = new Set<string>();
    const images: WorkspaceImage[] = [];

    for (const { agent, plan } of wanted) {
      if (seen.has(plan.fingerprint)) continue;
      seen.add(plan.fingerprint);

      try {
        images.push({ agent, fingerprint: plan.fingerprint, ...(await take(plan)) });
      } catch (err) {
        options.onProblem?.(agent, (err as Error).message);
        images.push({ agent, fingerprint: plan.fingerprint, state: 'failed', reference: '', detail: (err as Error).message });
      }
    }

    return images;
  };

  return {
    standing: (ownerId?: string) => each(ownerId, (plan) => options.images.standing(plan)),
    warm: (ownerId?: string) => each(ownerId, (plan) => options.images.start(plan)),

    async waiting(ownerId: string, agentSlug: string): Promise<string | undefined> {
      const [persona] = (await options.personas(ownerId)).filter((candidate) => candidate.slug === agentSlug);
      if (!persona) return undefined;

      const plan = planFor(persona, await options.tools(ownerId));
      if (!plan) return undefined;

      const state = await options.images.standing(plan);
      return sayWaiting({ agent: agentSlug, fingerprint: plan.fingerprint, ...state });
    },

    /**
     * Every fingerprint something would still build: each sandboxed persona's own image, plus the
     * shared workspace a grove tree works in. The pruner keeps these and lets go of the rest — a
     * fingerprint it drops by mistake is not a loss, because the same plan names the same image and
     * the next run rebuilds it.
     */
    async wanted(): Promise<WantedImage[]> {
      const rows = await options.personas();
      const owners = options.owners
        ? [...new Set([...await options.owners(), ...rows.map((persona) => persona.ownerId)])]
        : [...new Set(rows.map((persona) => persona.ownerId))];

      const wanted: WantedImage[] = [];
      const seen = new Set<string>();
      const want = (fingerprint: string | undefined, who: string) => {
        if (!fingerprint || seen.has(fingerprint)) return;
        seen.add(fingerprint);
        wanted.push({ fingerprint, who });
      };

      for (const ownerId of owners) {
        const [personas, tools] = await Promise.all([options.personas(ownerId), options.tools(ownerId)]);

        for (const persona of personas) {
          const plan = planFor(persona, tools);
          if (plan && needsBuilding(plan)) want(plan.fingerprint, persona.slug);
        }

        // The tree workspace is its own image: the union of the grove agents, not any one of them.
        const shared = mergeWorkspaceAgents(
          GROVE_WORKSPACE_AGENTS.map((slug) => personas.find((persona) => persona.slug === slug)),
          'grove-runner',
        );
        const plan = shared ? planFor(shared, tools) : undefined;
        if (plan && needsBuilding(plan)) want(plan.fingerprint, 'tree workspaces');
      }

      return wanted;
    },
  };
}
