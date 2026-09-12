import { sleep } from '@temporalio/workflow';
import {
  isWorkflowContainerNode, evalCondition, normalizeRunIf, resolvePath,
  type WorkflowStageNode, type WorkflowStageDefinition, type WorkflowStageGroup, type WorkflowStageLoop,
  type WorkflowStageType, type WorkflowEvalContext,
} from '../lib/leaf-workflow-types.js';

export type StageCtx = WorkflowEvalContext;
export type StageDispatch = Record<WorkflowStageType, (leafId: string) => Promise<unknown>>;

export async function runStageNodes(
  nodes: readonly WorkflowStageNode[],
  leafId: string,
  ctx: StageCtx,
  dispatch: StageDispatch,
): Promise<void> {
  for (const node of nodes) {
    if (isWorkflowContainerNode(node)) {
      await runStageContainer(node, leafId, ctx, dispatch);
    } else {
      await runStageLeaf(node, leafId, ctx, dispatch);
    }
  }
}

async function runStageLeaf(node: WorkflowStageDefinition, leafId: string, ctx: StageCtx, dispatch: StageDispatch): Promise<void> {
  if (node.runIf !== undefined && !evalCondition(normalizeRunIf(node.runIf), ctx)) {
    ctx.stages[node.id] = { ranOk: false, output: undefined };
    return;
  }

  const attempts = 1 + Math.max(0, node.retries ?? 0);
  let ranOk = false;
  let output: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      output = await dispatch[node.stage](leafId);
      ranOk = true;
      break;
    } catch (err) {
      if (attempt === attempts) {
        if (!node.optional) throw err;
      } else if (node.retryDelayMs) {
        await sleep(node.retryDelayMs);
      }
    }
  }

  ctx.stages[node.id] = { ranOk, output };
}

async function runStageContainer(node: WorkflowStageGroup | WorkflowStageLoop, leafId: string, ctx: StageCtx, dispatch: StageDispatch): Promise<void> {
  if (node.runIf !== undefined && !evalCondition(normalizeRunIf(node.runIf), ctx)) {
    ctx.stages[node.id] = { ranOk: false, output: undefined };
    return;
  }

  const ranOk = node.containerType === 'loop'
    ? await runStageLoop(node, leafId, ctx, dispatch)
    : await runScoped(node.children, leafId, ctx, dispatch);
  ctx.stages[node.id] = { ranOk, output: undefined };
}

async function runScoped(nodes: readonly WorkflowStageNode[], leafId: string, ctx: StageCtx, dispatch: StageDispatch): Promise<boolean> {
  await runStageNodes(nodes, leafId, ctx, dispatch);
  return nodes.length > 0 && nodes.every((n) => ctx.stages[n.id]?.ranOk === true);
}

async function runStageLoop(node: WorkflowStageLoop, leafId: string, ctx: StageCtx, dispatch: StageDispatch): Promise<boolean> {
  if (node.loopType === 'count') {
    const n = Math.max(1, node.maxIterations ?? 1);
    let lastOk = false;
    for (let i = 1; i <= n; i++) {
      lastOk = await runScoped(node.children, leafId, ctx, dispatch);
    }
    return lastOk;
  }

  if (node.loopType === 'until') {
    const cap = Math.max(1, node.maxIterations ?? 1);
    let lastOk = false;
    for (let i = 1; i <= cap; i++) {
      lastOk = await runScoped(node.children, leafId, ctx, dispatch);
      if (lastOk) break;
    }
    return lastOk;
  }

  if (!node.itemsFrom) return false;
  const items = resolvePath(ctx, node.itemsFrom);
  if (!Array.isArray(items) || items.length === 0) return false;

  const count = Math.min(items.length, 100);
  let allOk = true;
  for (let i = 0; i < count; i++) {
    const ok = await runScoped(node.children, leafId, ctx, dispatch);
    allOk = allOk && ok;
  }
  return allOk;
}
