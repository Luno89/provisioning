import { v4 as uuidv4 } from 'uuid';
import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import { sameAction, type ActionProposal } from '../../../lib/action-proposals.js';
import type { ReleaseHow } from '../../../lib/release-run.js';
import { PROPOSE_RELEASE_CHANGE } from './catalogue.js';

export interface ReleaseToolDeps {
  problem(ownerId: string, how: unknown): Promise<string | null>;
  treeTypes(ownerId: string): Promise<{ id: string; label: string }[]>;
  projects(ownerId: string): Promise<{ id: string; name: string }[]>;
  proposals: { list(ownerId: string): Promise<ActionProposal[]>; save(proposal: ActionProposal): Promise<void> };
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
}

const refuse = (reason: string): ToolOutcome => ({ ok: false, digest: reason, content: reason });
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const describe = (how: ReleaseHow): string => `the ${how.agent} agent${how.app ? ` with the ${how.app} adapter` : ''}`;

export function createReleaseTools(deps: ReleaseToolDeps): Record<string, ToolHandler> {
  return {
    async [PROPOSE_RELEASE_CHANGE]({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner to propose a release for');
      const args = (parsed ?? {}) as Record<string, unknown>;
      const typeId = text(args.treeType);
      const projectId = text(args.project);
      const why = text(args.why);
      if (!why) return refuse('say why, for the person to read on the card');
      if (Boolean(typeId) === Boolean(projectId)) return refuse('name either a tree type or a project, not both and not neither');

      const target = typeId
        ? (await deps.treeTypes(caller.ownerId)).find((entry) => entry.id === typeId)
        : (await deps.projects(caller.ownerId)).find((entry) => entry.id === projectId);
      if (!target) return refuse(typeId ? `there is no tree type ${typeId}` : `there is no project ${projectId}`);
      const name = 'label' in target ? target.label : target.name;

      const clear = args.clear === true;
      const agent = text(args.agent);
      const app = text(args.app);
      const how: ReleaseHow | undefined = clear ? undefined : { agent: agent ?? '', ...(app ? { app } : {}) };
      if (how) {
        const problem = await deps.problem(caller.ownerId, how);
        if (problem) return refuse(`${problem}; nothing was proposed`);
      }

      const params: Record<string, string> = {
        target: typeId ? 'treeType' : 'project',
        id: typeId ?? projectId!,
        ...(how ? { agent: how.agent, ...(how.app ? { app: how.app } : {}) } : { clear: 'true' }),
      };
      const open = (await deps.proposals.list(caller.ownerId)).find((entry) => entry.status === 'proposed' && sameAction(entry, 'set_release', params));
      if (open) return { ok: true, digest: `already proposed: ${open.summary}`, content: `This is already waiting for the person on a card (${open.summary}); nothing new was proposed.` };

      const what = typeId ? `${name} (every project of this tree type)` : name;
      const summary = how
        ? `Release ${what} with ${describe(how)}`
        : typeId ? `Release ${name} the way its repository says` : `Release ${name} the way its tree type does`;
      const stamp = (deps.now ?? (() => new Date().toISOString()))();
      const proposal: ActionProposal = {
        id: (deps.newId ?? uuidv4)(),
        ownerId: caller.ownerId,
        kind: 'set_release',
        summary,
        why,
        detail: [summary],
        params,
        status: 'proposed',
        ...(caller.conversationId ? { conversationId: caller.conversationId } : {}),
        ...(caller.runId ? { runId: caller.runId } : {}),
        createdAt: stamp,
        updatedAt: stamp,
      };
      await deps.proposals.save(proposal);
      return { ok: true, digest: `proposed: ${summary}`, content: `Proposed on a card: ${summary}. Nothing changes until the person applies it.` };
    },
  };
}
