import { isAxiosError, type AxiosInstance } from 'axios';
import type { CheckAccess, CheckRunView } from '../engine-host/tools/check-tools.js';
import type { Scenario } from '../eval/level2/scenario.js';

const said = (err: unknown): string => {
  if (isAxiosError(err)) {
    const body = err.response?.data as { error?: string; problems?: string[] } | undefined;
    return body?.error ?? err.message;
  }
  return (err as Error).message;
};

export function httpCheckAccess(asOwner: (ownerId: string) => Promise<AxiosInstance>): CheckAccess {
  const base = '/evals/level2';
  return {
    async scenarios(ownerId) {
      return (await (await asOwner(ownerId)).get<{ scenarios: (Scenario & { mine: boolean })[] }>(`${base}/scenarios`)).data.scenarios;
    },
    async runs(ownerId) {
      return (await (await asOwner(ownerId)).get<{ runs: CheckRunView[] }>(`${base}/runs`)).data.runs;
    },
    async run(ownerId, runId) {
      try {
        return (await (await asOwner(ownerId)).get<CheckRunView>(`${base}/runs/${encodeURIComponent(runId)}`)).data;
      } catch (err) {
        if (isAxiosError(err) && err.response?.status === 404) return undefined;
        throw err;
      }
    },
    async save(ownerId, scenario) {
      const id = String((scenario as { id?: unknown }).id ?? '');
      if (!id) return { problems: ['a check needs an id: lower-case words joined by dashes'] };
      try {
        const saved = (await (await asOwner(ownerId)).put<{ scenario: Scenario }>(`${base}/scenarios/${encodeURIComponent(id)}`, scenario)).data.scenario;
        return { saved: saved.id };
      } catch (err) {
        if (isAxiosError(err) && err.response?.status === 400) {
          const body = err.response.data as { error?: string; problems?: string[] };
          return { problems: body.problems?.length ? body.problems : [body.error ?? 'it was refused'] };
        }
        throw err;
      }
    },
    async remove(ownerId, id) {
      try {
        await (await asOwner(ownerId)).delete(`${base}/scenarios/${encodeURIComponent(id)}`);
        return true;
      } catch (err) {
        if (isAxiosError(err) && err.response?.status === 404) return false;
        throw err;
      }
    },
    async start(ownerId, input) {
      try {
        const run = (await (await asOwner(ownerId)).post<{ id: string }>(`${base}/runs`, input)).data;
        return { runId: run.id };
      } catch (err) {
        if (isAxiosError(err) && err.response && err.response.status < 500) return { problem: said(err) };
        throw err;
      }
    },
  };
}
