import { v4 as uuidv4 } from 'uuid';
import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import { sameAction, type ActionProposal } from '../../../engine/lib/action-proposals.js';
import type { ReleaseHow } from '../../../releases/lib/release-run.js';
import { APP_DRIFT, EXPORT_CUSTOMIZATIONS, PROPOSE_ADOPT_CUSTOMIZATIONS, PROPOSE_RELEASE_CHANGE } from './catalogue.js';
import { driftText } from '../../../releases/lib/app-drift.js';
import type { CustomizationsService } from '../../../releases/services/CustomizationsService.js';

export interface ReleaseToolDeps {
  problem(ownerId: string, how: unknown): Promise<string | null>;
  treeTypes(ownerId: string): Promise<{ id: string; label: string }[]>;
  projects(ownerId: string): Promise<{ id: string; name: string }[]>;
  proposals: { list(ownerId: string): Promise<ActionProposal[]>; save(proposal: ActionProposal): Promise<void> };
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
  customizations?: Pick<CustomizationsService, 'drift' | 'propose' | 'exportItems'> | undefined;
  projectOfTree?: ((ownerId: string, treeId: string) => Promise<string | undefined>) | undefined;
}

const refuse = (reason: string): ToolOutcome => ({ ok: false, digest: reason, content: reason });
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const describe = (how: ReleaseHow): string => `the ${how.agent} agent${how.app ? ` with the ${how.app} adapter` : ''}`;

export function createReleaseTools(deps: ReleaseToolDeps): Record<string, ToolHandler> {
  const projectOf = async (args: Record<string, unknown>, caller: { ownerId?: string | undefined; projectId?: string | undefined; treeId?: string | undefined }): Promise<string | undefined> =>
    text(args.project) ?? caller.projectId ?? (caller.treeId && caller.ownerId ? await deps.projectOfTree?.(caller.ownerId, caller.treeId) : undefined);

  return {
    async [APP_DRIFT]({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId || !deps.customizations) return refuse('what a live app holds cannot be read here');
      const projectId = await projectOf((parsed ?? {}) as Record<string, unknown>, caller);
      if (!projectId) return refuse('name the project, by id');
      const drift = await deps.customizations.drift(caller.ownerId, projectId);
      if (!drift.ok) return refuse(drift.error);
      return { ok: true, digest: `${drift.value.items.length} made in the app, not in git`, content: driftText(drift.value.project, drift.value.module, drift.value.items) };
    },

    async [PROPOSE_ADOPT_CUSTOMIZATIONS]({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId || !deps.customizations) return refuse('customizations cannot be proposed here');
      const args = (parsed ?? {}) as Record<string, unknown>;
      const projectId = await projectOf(args, caller);
      if (!projectId) return refuse('name the project, by id');
      const proposed = await deps.customizations.propose(caller.ownerId, projectId, { ...(args.refs !== undefined ? { refs: args.refs } : {}), why: args.why }, {
        ...(caller.conversationId ? { conversationId: caller.conversationId } : {}),
        ...(caller.runId ? { runId: caller.runId } : {}),
      });
      if (!proposed.ok) return refuse(`${proposed.error}; nothing was proposed`);
      const story = proposed.value.change?.add?.leaves[0]?.title ?? 'the story';
      return { ok: true, digest: `proposed: ${story}`, content: `Proposed on a card: "${story}". Approving it adds the story to the project's tree and runs it; nothing changes until the person approves.` };
    },

    async [EXPORT_CUSTOMIZATIONS]({ parsed, caller, driver }): Promise<ToolOutcome> {
      if (!caller.ownerId || !deps.customizations) return refuse('customizations cannot be exported here');
      if (!driver) return refuse('this run has no workspace to write the module into');
      const args = (parsed ?? {}) as Record<string, unknown>;
      const projectId = await projectOf(args, caller);
      if (!projectId) return refuse('name the project, by id');
      const refs = Array.isArray(args.refs) ? args.refs.filter((ref): ref is string => typeof ref === 'string') : [];
      const exported = await deps.customizations.exportItems(caller.ownerId, projectId, refs);
      if (!exported.ok) return refuse(exported.error);
      if (exported.value.refused.length) return refuse(`nothing was written: ${exported.value.refused.map((entry) => `${entry.key}: ${entry.why}`).join('; ')}`);
      for (const file of exported.value.files) await driver.writeFile(file.path, file.content);
      return {
        ok: true,
        digest: `wrote ${exported.value.files.length} files into addons/${exported.value.module}`,
        content: [`Wrote addons/${exported.value.module}, exact copies of the live app's records (do not edit them):`, ...exported.value.files.map((file) => `- ${file.path}`), `Next: check it installs with odoo-check, then commit.`].join('\n'),
      };
    },


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
