import type { PersonaPack } from '@koala/harness-types';
import type { Leaf } from './leaves.js';
import type { ProjectMetadata } from './types.js';
import type { ValidationRecipe } from './tree-types.js';
import {
  branchNameFor, baseBranchesFor, buildCheckoutScript, checkpointPath,
} from './leaf-checkout.js';
import {
  prepareInputs, buildInputIndex, buildInlineInputs, REQUIRED_TOOL,
} from './dependency-inputs.js';
import { allowedTools } from './persona-scope.js';
import { WORKSPACE_MOUNT } from './workspace-spec.js';

export const MAX_FINDINGS_CHARS = 20000;

export interface RepoTaskContextParams {
  baseContext: string;
  project: Pick<ProjectMetadata, 'giteaOwner' | 'giteaRepo'>;
  branchName: string;
  hasPreviousOutputBranch: boolean;
  hasDependencyBases: boolean;
  leafRecipe: ValidationRecipe | undefined;
}

export function buildRepoTaskContext(params: RepoTaskContextParams): string {
  const { baseContext, project, branchName, hasPreviousOutputBranch, hasDependencyBases, leafRecipe } = params;
  return [
    baseContext,
    '',
    `The repository ${project.giteaOwner}/${project.giteaRepo} is cloned at /work/repo, on a new branch "${branchName}".`,
    ...(hasPreviousOutputBranch
      ? ['A PREVIOUS ATTEMPT at this same task already committed here. Read what is there first and continue from it — do not start over.']
      : []),
    ...(hasDependencyBases
      ? [`It also contains the work of the leaves this one depends on. Build on what is there rather than starting over.`]
      : []),
    'Work there. Commit your changes with git as you go. Do NOT change the git remote or credentials —',
    'they are already configured. When you are done, push with `git push -u origin HEAD`.',
    'Runtime Environment & Secrets: Your application runs in a container where configuration and credentials are provided as standard environment variables (e.g. process.env.<NAME>, os.environ[\'<NAME>\']). Read all secrets from environment variables with sensible defaults or clean error handling on missing values. Never hardcode sensitive tokens.',
    ...(leafRecipe
      ? [
          '',
          '## Validation & Quality Gate',
          'The Validator will independently evaluate your work using the project ValidationRecipe.',
          'You can call the `validate_progress` tool at any time during execution to test your changes against these checks.',
          'When you finish, the Validator will test your work. If any checks fail, you will be handed back the exact diagnostic errors for another refinement iteration.',
        ]
      : []),
  ].join('\n');
}

export interface DocumentTaskContextParams {
  baseContext: string;
  outputPath: string;
  wantsRepo: boolean;
  outputBranch: string | undefined;
  priorFindings: string | undefined;
  inputsBlock: string;
}

export function buildDocumentTaskContext(params: DocumentTaskContextParams): string {
  const { baseContext, outputPath, wantsRepo, outputBranch, priorFindings, inputsBlock } = params;
  const findings = priorFindings?.trim() ?? '';
  return [
    baseContext,
    '',
    'There is no repository here and nothing to commit.',
    `Your answer goes in ${outputPath}. That file IS the deliverable — it is the only thing`,
    'kept when this sandbox is destroyed, and an answer that exists only in your replies is lost.',
    '',
    `WRITE ${outputPath} EARLY, even if it is only an outline, and then keep rewriting it as`,
    'you learn more. A run that spends its whole budget researching and never writes the file has',
    'produced nothing.',
    '',
    'AN OUTLINE IS NOT AN ANSWER. Do not call finish while any section is a heading with nothing',
    'under it, or says "TBD", "TODO" or "to be filled" — that is checked, and it fails the leaf.',
    'Every section must contain what you actually found, in prose.',
    '',
    'Use web_search and fetch_web_page to check what you write rather than answering from memory,',
    'and include the URLs you used — an answer citing no sources fails. Spend no more than about',
    'half your steps searching; the rest belongs to writing.',
    '',
    'This sandbox has NO network access. curl and wget will silently return nothing —',
    'web_search and fetch_web_page are the only way out, and they stop working halfway',
    'through the run so that the second half is spent writing.',
    ...(findings
      ? (wantsRepo && outputBranch
        ? [
            '',
            `A PREVIOUS ATTEMPT already wrote ${outputPath} and pushed it to "${outputBranch}",`,
            'which is the branch checked out for you. READ THAT FILE FIRST, then fix what the',
            'failure above says was wrong with it. Do not start over and do not rewrite it from',
            'scratch — most of it is right.',
          ]
        : [
            '',
            `A PREVIOUS ATTEMPT wrote this. Start by writing it back to ${outputPath}, then fix`,
            'what the failure above says was wrong with it. Do not start over.',
            '',
            findings,
          ])
      : []),
    ...(inputsBlock ? ['', inputsBlock] : []),
  ].join('\n');
}

export interface DependencyInputsDeps {
  workspaces: { writeFile(leafId: string, path: string, content: string): Promise<unknown> };
}

export async function assembleDependencyInputsBlock(
  deps: DependencyInputsDeps,
  leafId: string,
  dependsOnFindings: readonly { leafId: string; title: string; findings: string }[],
  canReadFiles: boolean,
): Promise<string> {
  const preparedInputs = prepareInputs(dependsOnFindings);
  if (!preparedInputs.length) return '';

  if (!canReadFiles) return buildInlineInputs(preparedInputs);

  const written = await Promise.all(preparedInputs.map((input) =>
    deps.workspaces.writeFile(leafId, input.path, input.content)
      .then(() => true)
      .catch((err: Error) => {
        console.warn(`[leaf-task-context] ${leafId}: could not write ${input.path}: ${err.message}`);
        return false;
      })));
  const landed = preparedInputs.filter((_, i) => written[i]);
  return [
    buildInputIndex(landed, WORKSPACE_MOUNT),
    ...(landed.length < preparedInputs.length
      ? [buildInlineInputs(preparedInputs.filter((_, i) => !written[i]))]
      : []),
  ].filter(Boolean).join('\n\n');
}

export interface AssembleTaskContextDeps {
  workspaces: {
    exec(leafId: string, script: string, timeoutMs?: number, args?: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
    readFile(leafId: string, path: string): Promise<string>;
    writeFile(leafId: string, path: string, content: string): Promise<unknown>;
  };
}

export interface AssembleTaskContextParams {
  leaf: Pick<Leaf, 'id' | 'outputBranch' | 'dependsOn' | 'findings'>;
  allLeaves: readonly Leaf[];
  baseContext: string;
  checkout: { cloneUrl: string } | undefined;
  giteaBaseUrl: string;
  project: Pick<ProjectMetadata, 'giteaOwner' | 'giteaRepo'> | undefined;
  leafRecipe: ValidationRecipe | undefined;
  outputPath: string | undefined;
  wantsRepo: boolean;
  pack: Pick<PersonaPack, 'tools'> | null | undefined;
}

export interface AssembledTaskContext {
  taskContext: string;
  branchName: string | undefined;
}

export async function assembleLeafTaskContext(
  deps: AssembleTaskContextDeps,
  params: AssembleTaskContextParams,
): Promise<AssembledTaskContext> {
  const { leaf, allLeaves, baseContext, checkout, giteaBaseUrl, project, leafRecipe, outputPath, wantsRepo, pack } = params;

  let taskContext = baseContext;
  let branchName: string | undefined;

  if (checkout && project) {
    branchName = branchNameFor(leaf.id);
    const baseBranches = [
      ...(leaf.outputBranch ? [leaf.outputBranch] : []),
      ...baseBranchesFor(leaf, allLeaves as Leaf[]),
    ];
    const cleanUrl = `${giteaBaseUrl}/${project.giteaOwner}/${project.giteaRepo}.git`;
    const cloned = await deps.workspaces.exec(
      leaf.id,
      buildCheckoutScript({ cloneUrl: checkout.cloneUrl, cleanUrl, branch: branchName, baseBranches }),
      180_000,
      [checkout.cloneUrl, branchName, cleanUrl],
    );
    if (cloned.exitCode !== 0) {
      throw new Error(`Could not clone ${project.giteaOwner}/${project.giteaRepo}: ${cloned.stderr.slice(0, 300)}`);
    }

    taskContext = buildRepoTaskContext({
      baseContext,
      project,
      branchName,
      hasPreviousOutputBranch: Boolean(leaf.outputBranch),
      hasDependencyBases: baseBranchesFor(leaf, allLeaves as Leaf[]).length > 0,
      leafRecipe,
    });

    const priorCheckpoint = await deps.workspaces
      .readFile(leaf.id, `/work/repo/${checkpointPath(leaf.id)}`)
      .catch(() => '');
    if (priorCheckpoint.trim()) {
      taskContext = [
        taskContext, '', '## WHERE THE LAST ATTEMPT LEFT OFF', priorCheckpoint.trim().slice(0, MAX_FINDINGS_CHARS),
      ].join('\n');
    }
  }

  if (outputPath) {
    const dependsOnFindings = allLeaves
      .filter((l) => (leaf.dependsOn ?? []).includes(l.id) && l.findings?.trim())
      .map((l) => ({ leafId: l.id, title: l.title, findings: l.findings! }));
    const canReadFiles = allowedTools(pack, [REQUIRED_TOOL]).includes(REQUIRED_TOOL);
    const inputsBlock = await assembleDependencyInputsBlock(deps, leaf.id, dependsOnFindings, canReadFiles);

    taskContext = buildDocumentTaskContext({
      baseContext,
      outputPath,
      wantsRepo,
      outputBranch: leaf.outputBranch,
      priorFindings: leaf.findings,
      inputsBlock,
    });
  }

  return { taskContext, branchName };
}
