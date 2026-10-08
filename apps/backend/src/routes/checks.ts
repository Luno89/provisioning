import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { ScriptedModelService } from '../services/ScriptedModelService.js';

const userOf = (req: Request): { id: string } => (req as unknown as { user: { id: string } }).user;
const tokenOf = (req: Request): string => String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
const spaceOf = (req: Request): string => String(req.params.spaceId ?? '');

const chunk = (model: string, delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, number>): string =>
  `data: ${JSON.stringify({ id: 'scripted', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const SCRIPTED_MODEL = 'scripted';

export function checksRouter(deps: { scripted: ScriptedModelService }): Router {
  const router = Router();

  router.get('/scripted/:spaceId/v1/models', asyncRoute(async (req: Request, res: Response) => {
    if (!(await deps.scripted.knows(spaceOf(req), tokenOf(req)))) return res.status(401).json({ error: { message: 'that is not this check\'s key' } });
    return res.json({ object: 'list', data: [{ id: SCRIPTED_MODEL, object: 'model' }] });
  }));

  router.post('/scripted/:spaceId/v1/chat/completions', asyncRoute(async (req: Request, res: Response) => {
    const outcome = await deps.scripted.answer(spaceOf(req), tokenOf(req), req.body);
    if ('refused' in outcome) return res.status(outcome.refused).json({ error: { message: outcome.error } });
    if ('miss' in outcome) return res.status(422).json({ error: { message: outcome.miss } });

    const { answer } = outcome;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(chunk(SCRIPTED_MODEL, { role: 'assistant' }));
    if (answer.say && answer.paceMs) {
      for (const piece of answer.say.match(/\S+\s*/g) ?? [answer.say]) {
        if (res.destroyed) return undefined;
        res.write(chunk(SCRIPTED_MODEL, { content: piece }));
        await sleep(answer.paceMs);
      }
    } else if (answer.say) {
      res.write(chunk(SCRIPTED_MODEL, { content: answer.say }));
    }
    answer.calls.forEach((call, index) => {
      res.write(chunk(SCRIPTED_MODEL, { tool_calls: [{ index, id: `call_${Date.now().toString(36)}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }));
    });
    const sent = JSON.stringify(req.body ?? {}).length;
    res.write(chunk(SCRIPTED_MODEL, {}, answer.calls.length ? 'tool_calls' : 'stop', { prompt_tokens: Math.ceil(sent / 4), completion_tokens: 20, total_tokens: Math.ceil(sent / 4) + 20 }));
    res.end('data: [DONE]\n\n');
    return undefined;
  }));

  router.get('/model-requests', asyncRoute(async (req: Request, res: Response) => {
    res.json({ requests: await deps.scripted.requests(userOf(req).id) });
  }));

  return router;
}
