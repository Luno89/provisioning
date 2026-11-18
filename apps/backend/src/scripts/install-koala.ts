import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chartInputs, chartStep, runSteps, StepFailed, terminalReporter } from '@koala/provision';
import { clusterAccessOfKubeconfig } from '../infrastructure/index.js';
import { installArgsOf, KOALA_CHART_STEP, valuesFilesIn } from '../instances/index.js';

async function chartParts(chart: string): Promise<(string | Buffer)[]> {
  if (!(await stat(chart)).isDirectory()) return [await readFile(chart)];
  const files = (await readdir(chart, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort();
  return (await Promise.all(files.map(async (file) => [relative(chart, file), await readFile(file)]))).flat();
}

async function main(): Promise<void> {
  const asked = installArgsOf(process.argv.slice(2));
  const { access, target } = clusterAccessOfKubeconfig(await readFile(asked.kubeconfig, 'utf8'), asked.release);
  const inputs = chartInputs([
    ...await chartParts(asked.chart),
    ...asked.values,
    ...await Promise.all(valuesFilesIn(asked.values).map((file) => readFile(file))),
  ]);
  await runSteps([chartStep(KOALA_CHART_STEP, { release: asked.release, namespace: asked.namespace, chart: asked.chart, values: asked.values, inputs })], { cluster: access.chartCluster(target) }, terminalReporter(process.stdout));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    if (!(err instanceof StepFailed)) console.error(`Koala's chart could not be applied: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
