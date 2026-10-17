import { describe, expect, it } from "vitest";
import { probeTarget } from "./app-probe.js";

describe("probeTarget", () => {
  it("probes the app's health path, not only its port", () => {
    expect(probeTarget({ serviceName: "minio", namespace: "minio", servicePort: 9000, path: "/minio/health/live" })).toBe("minio.minio.svc.cluster.local:9000/minio/health/live");
  });

  it("probes the root when no path is given", () => {
    expect(probeTarget({ serviceName: "web", namespace: "shop", servicePort: 80 })).toBe("web.shop.svc.cluster.local:80");
  });

  it("adds the leading slash a path left out", () => {
    expect(probeTarget({ serviceName: "q", namespace: "q", servicePort: 6333, path: "healthz" })).toBe("q.q.svc.cluster.local:6333/healthz");
  });
});
