import type { EnvironmentDriver } from '@koala/engine-core';
import type { EnvironmentHandleRef, RunTicket } from '../temporal/contracts.js';

export interface CodeRunRequest {
  ticket: RunTicket;
  nodeId: string;
  body: string;
  inputs: Record<string, unknown>;
  timeoutMs: number;
  environment?: EnvironmentHandleRef | undefined;
}

export type CodeRunOutcome =
  | { ok: true; outputs: Record<string, unknown> }
  | { ok: false; error: string };

export interface CodeRunner {
  run(request: CodeRunRequest): Promise<CodeRunOutcome>;
}

export interface CodeRunnerOptions {
  environments: {
    forRun(request: { ticket: RunTicket; environment?: EnvironmentHandleRef | undefined }): Promise<EnvironmentDriver | undefined>;
  };
}

const WHERE = '.koala';

export function wrapBody(body: string, inputsPath: string, outputsPath: string): string {
  return [
    "import { readFile, writeFile } from 'node:fs/promises';",
    `const inputs = JSON.parse(await readFile(${JSON.stringify(inputsPath)}, 'utf8'));`,
    'const run = async (inputs) => {',
    body,
    '};',
    'const outputs = await run(inputs);',
    `await writeFile(${JSON.stringify(outputsPath)}, JSON.stringify(outputs ?? {}));`,
  ].join('\n');
}

export function readOutputs(written: string): CodeRunOutcome {
  if (!written.trim()) return { ok: true, outputs: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(written);
  } catch {
    return { ok: false, error: 'the code handed back something that is not JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'the code has to hand back an object of the values it declares' };
  }

  return { ok: true, outputs: parsed as Record<string, unknown> };
}

export function createCodeRunner(options: CodeRunnerOptions): CodeRunner {
  return {
    async run(request: CodeRunRequest): Promise<CodeRunOutcome> {
      const driver = await options.environments.forRun({
        ticket: request.ticket,
        ...(request.environment ? { environment: request.environment } : {}),
      });
      if (!driver) return { ok: false, error: 'this run has no sandbox, and code needs one to run in' };

      const safe = request.nodeId.replace(/[^a-zA-Z0-9_-]+/g, '-');
      const script = `${WHERE}/${safe}.mjs`;
      const inputsPath = `${WHERE}/${safe}.in.json`;
      const outputsPath = `${WHERE}/${safe}.out.json`;

      await driver.writeFile(inputsPath, JSON.stringify(request.inputs));
      await driver.writeFile(script, wrapBody(request.body, inputsPath, outputsPath));
      await driver.writeFile(outputsPath, '');

      const outcome = await driver.exec({ command: `node ${script}`, timeoutMs: request.timeoutMs });
      if (outcome.exitCode !== 0) {
        const said = (outcome.stderr || outcome.stdout || '').trim();
        return { ok: false, error: said ? `the code failed: ${said}` : `the code exited ${outcome.exitCode} without saying why` };
      }

      return readOutputs(await driver.readFile(outputsPath));
    },
  };
}
