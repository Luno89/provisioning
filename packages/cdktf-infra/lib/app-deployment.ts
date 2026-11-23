import type { Construct } from "constructs";
import { Deployment, type DeploymentConfig, type DeploymentSpecTemplateSpec } from "../.gen/providers/kubernetes/deployment/index.js";
import { type VpnConfig, VpnService } from "./vpn-service.js";

export class AppDeployment extends Deployment {
  constructor(scope: Construct, id: string, config: DeploymentConfig) {
    super(scope, id, {
      ...config,
      spec: { ...config.spec, template: { ...config.spec.template, spec: { ...config.spec.template.spec, automountServiceAccountToken: false } } },
    });
  }
}

export function appDeployment(scope: Construct, id: string, app: { name: string; namespace: string; label: string; pod: DeploymentSpecTemplateSpec; vpn: VpnConfig }): AppDeployment {
  VpnService.apply(scope, app.namespace, app.pod, app.vpn);
  return new AppDeployment(scope, id, {
    waitForRollout: false,
    metadata: { name: app.name, namespace: app.namespace, labels: { app: app.label } },
    spec: {
      replicas: "1",
      selector: { matchLabels: { app: app.label } },
      template: { metadata: { labels: { app: app.label } }, spec: app.pod },
    },
  });
}
