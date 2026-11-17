import fs from 'fs/promises';
import { ApplicationFailure } from '@temporalio/common';

import {
  appStackName, type DestroyAppArgs, namespaceOf, NO_STACK_ID, platformNamespaceProblem, PLATFORM_NAMESPACES, removeNamespace,
} from '../infrastructure/index.js';
import { ODOO_PROJECT_APP } from '../releases/index.js';
import { ignore } from '@koala/engine-core/failures';
import type { ClusterSteps } from './cluster-steps.js';
import { handedReach } from './handed-reach.js';
import { appServiceType, placedOnPool } from '../infrastructure/index.js';

export type { DestroyAppArgs } from '../infrastructure/index.js';

export interface DestroyAppResult {
  status: string;
  msg: string;
}

export async function DestroyAppActivity(args: DestroyAppArgs, steps: ClusterSteps): Promise<DestroyAppResult> {
  const namespace = namespaceOf(args);
  const platform = platformNamespaceProblem(namespace, PLATFORM_NAMESPACES);
  if (platform) throw ApplicationFailure.nonRetryable(platform);

  const reach = handedReach(args);
  const kubectl = (argv: string[]) => steps.access.kubectl(reach, argv);
  const logFile = args.logFile;

  if (args.appType === ODOO_PROJECT_APP) {
    await fs.appendFile(logFile, `Uninstalling the Odoo release ${namespace} and its namespace, databases and attachments with it\n`).catch(ignore('the log only shows progress, and the work goes on without it'));
    await steps.access.helm(reach, ['uninstall', namespace, '-n', namespace, '--ignore-not-found']);
    await removeNamespace(kubectl, namespace);
    return { status: 'destroyed', msg: `App ${args.name} destroyed` };
  }

  if (!args.deploymentId) throw ApplicationFailure.nonRetryable(`${args.name} ${NO_STACK_ID}`);
  const physicalName = args.clusterName;
  await steps.infra.destroy(appStackName(physicalName, args.deploymentId), {
    logFile,
    env: {
      STACK_TYPE: 'app',
      CLUSTER_NAME: physicalName,
      DEPLOYMENT_STRATEGY: args.strategy,
      DEPLOYMENT_NAME: namespace,
      DEPLOYMENT_ID: args.deploymentId,
      KUBECONFIG: await steps.access.kubeconfigOf(reach),
      APP_SERVICE_TYPE: appServiceType(placedOnPool(Boolean(steps.access.here.poolName), reach)),
    },
  });

  await removeNamespace(kubectl, namespace);

  return { status: 'destroyed', msg: `App ${args.name} destroyed` };
}
