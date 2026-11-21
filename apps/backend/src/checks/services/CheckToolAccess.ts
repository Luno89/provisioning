import axios, { isAxiosError, type AxiosInstance } from 'axios';
import type { CheckAccess, CheckRunView, RunCaller } from '../../engine-host/tools/check-tools.js';
import type { Scenario } from '../../eval/level2/scenario.js';

const said = (err: unknown): string => {
  if (isAxiosError(err)) {
    const body = err.response?.data as { error?: string; problems?: string[] } | undefined;
    return body?.error ?? err.message;
  }
  return (err as Error).message;
};

export function bearerApi(baseURL: string, bearer: () => Promise<string>): AxiosInstance {
  const api = axios.create({ baseURL, proxy: false });
  api.interceptors.request.use((config) => bearer().then((token) => {
    config.headers.set('Authorization', `Bearer ${token}`);
    return config;
  }));
  return api;
}

export function httpCheckAccess(asRun: (who: RunCaller) => Promise<AxiosInstance>): CheckAccess {
  const base = '/evals/level2';
  return {
    async scenarios(who) {
      return (await (await asRun(who)).get<{ scenarios: (Scenario & { mine: boolean })[] }>(`${base}/scenarios`)).data.scenarios;
    },
    async runs(who) {
      return (await (await asRun(who)).get<{ runs: CheckRunView[] }>(`${base}/runs`)).data.runs;
    },
    async run(who, runId) {
      try {
        return (await (await asRun(who)).get<CheckRunView>(`${base}/runs/${encodeURIComponent(runId)}`)).data;
      } catch (err) {
        if (isAxiosError(err) && err.response?.status === 404) return undefined;
        throw err;
      }
    },
    async save(who, scenario) {
      const id = String((scenario as { id?: unknown }).id ?? '');
      if (!id) return { problems: ['a check needs an id: lower-case words joined by dashes'] };
      try {
        const saved = (await (await asRun(who)).put<{ scenario: Scenario }>(`${base}/scenarios/${encodeURIComponent(id)}`, scenario)).data.scenario;
        return { saved: saved.id };
      } catch (err) {
        if (isAxiosError(err) && err.response?.status === 400) {
          const body = err.response.data as { error?: string; problems?: string[] };
          return { problems: body.problems?.length ? body.problems : [body.error ?? 'it was refused'] };
        }
        throw err;
      }
    },
    async remove(who, id) {
      try {
        await (await asRun(who)).delete(`${base}/scenarios/${encodeURIComponent(id)}`);
        return true;
      } catch (err) {
        if (isAxiosError(err) && err.response?.status === 404) return false;
        throw err;
      }
    },
    async start(who, input) {
      try {
        const run = (await (await asRun(who)).post<{ id: string }>(`${base}/runs`, input)).data;
        return { runId: run.id };
      } catch (err) {
        if (isAxiosError(err) && err.response && err.response.status < 500) return { problem: said(err) };
        throw err;
      }
    },
  };
}
