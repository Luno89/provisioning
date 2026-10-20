export const defaultServiceType = (): string =>
  process.env.APP_SERVICE_TYPE || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");
